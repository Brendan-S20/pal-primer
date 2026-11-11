// A half-typed office form survives a reload (gaps-r2-12, extends R2-33).
//
// Setup step 1 and the new-client wizard held everything in React state, so a
// phone browser reload, Android back or an app kill emptied them, and the
// wizard went back to step 1. Both now keep a draft on the device per user,
// organization and form (src/lib/form-drafts.ts, src/hooks/useFormDraft.ts),
// offer "Discard draft", and drop it on a successful save and on sign-out.
//
// No DOM library is installed here, so "reload" is the same storage read back
// by a fresh call, which is what a remounted form does; the wiring into the
// two screens is pinned by reading their source, as the walk-report test does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// ── A localStorage that lives in a Map, and survives a "reload" ────────────
class MemoryStorage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const local = new MemoryStorage();
(globalThis as unknown as { window: unknown }).window = { localStorage: local };

const {
  FORM_DRAFT_PREFIX,
  FORM_DRAFT_TTL_MS,
  clearAllFormDrafts,
  clearFormDraft,
  draftDiffers,
  formDraftKey,
  loadFormDraft,
  newClientDraftForm,
  saveFormDraft,
  stripSensitive,
} = await import("@/lib/form-drafts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const OWNER = "11111111-1111-4111-8111-111111111111";
const OFFICE = "22222222-2222-4222-8222-222222222222";
const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

beforeEach(() => local.clear());

describe("a reload mid-wizard brings back the step and the values", () => {
  it("reads back what was kept, step included", () => {
    const key = formDraftKey(OWNER, ORG_A, newClientDraftForm(null, null));
    saveFormDraft(key, { step: 2, displayName: "Rivera household", street: "12 Elm St" });

    // Reload: the page is gone and the wizard mounts again.
    const again = formDraftKey(OWNER, ORG_A, "new-client");
    expect(loadFormDraft(again)).toEqual({
      step: 2,
      displayName: "Rivera household",
      street: "12 Elm St",
    });
  });

  it("keeps setup step 1's untouched fields as untouched", () => {
    const key = formDraftKey(OWNER, ORG_A, "setup-business");
    saveFormDraft(key, { lines: null, name: null, phone: "512-555-0100", address: null, tz: null });
    expect(loadFormDraft(key)).toEqual({
      lines: null,
      name: null,
      phone: "512-555-0100",
      address: null,
      tz: null,
    });
  });
});

describe("a draft belongs to one person, one business and one form", () => {
  it("is not read by somebody else on the same device", () => {
    saveFormDraft(formDraftKey(OWNER, ORG_A, "new-client"), { displayName: "Owner's" });
    expect(loadFormDraft(formDraftKey(OFFICE, ORG_A, "new-client"))).toBeNull();
  });

  it("is not read under the owner's other business", () => {
    saveFormDraft(formDraftKey(OWNER, ORG_A, "new-client"), { displayName: "A's client" });
    expect(loadFormDraft(formDraftKey(OWNER, ORG_B, "new-client"))).toBeNull();
  });

  it("keeps one lead's answers away from another lead and from a blank wizard", () => {
    expect(newClientDraftForm({ id: "lead-1" }, null)).toBe("new-client:lead:lead-1");
    expect(newClientDraftForm({ id: "lead-1" }, { id: "q-1" })).toBe("new-client:quote:q-1");
    saveFormDraft(formDraftKey(OWNER, ORG_A, newClientDraftForm({ id: "lead-1" }, null)), {
      displayName: "Lead one",
    });
    expect(
      loadFormDraft(formDraftKey(OWNER, ORG_A, newClientDraftForm({ id: "lead-2" }, null))),
    ).toBeNull();
    expect(loadFormDraft(formDraftKey(OWNER, ORG_A, newClientDraftForm(null, null)))).toBeNull();
  });

  it("is never written when nobody, or no business, can be named", () => {
    expect(formDraftKey(null, ORG_A, "new-client")).toBeNull();
    expect(formDraftKey(OWNER, null, "new-client")).toBeNull();
    saveFormDraft(null, { displayName: "x" });
    expect(local.length).toBe(0);
  });
});

describe("never a secret or a card", () => {
  it("drops any field named for one, however deep", () => {
    expect(
      stripSensitive({
        displayName: "Rivera",
        gateCode: "4512#",
        gate_code: "4512#",
        password: "hunter2",
        cardNumber: "4242424242424242",
        cvc: "123",
        lockBoxCode: "9090",
        dogs: [{ name: "Luna", accessToken: "t" }],
        hz: { aggressiveDog: true },
      }),
    ).toEqual({ displayName: "Rivera", dogs: [{ name: "Luna" }], hz: { aggressiveDog: true } });
  });

  it("strips before writing, so storage never holds one", () => {
    const key = formDraftKey(OWNER, ORG_A, "new-client");
    saveFormDraft(key, { displayName: "Rivera", gateCode: "4512#" });
    expect(local.getItem(key!)).not.toContain("4512");
  });

  it("the wizard does not hand its gate code to the draft at all", () => {
    const src = read("src/routes/_authenticated/clients.new.tsx");
    // The kept value is built as `draftValue` just above the hook (#784).
    const block = src.slice(src.indexOf("const draftValue"), src.indexOf("reset: onDiscarded"));
    expect(block).not.toMatch(/gateCode/);
    expect(block).toMatch(/\bstep,/);
    expect(block).toMatch(/setStep\(d\.step\)/);
  });
});

describe("a draft ends", () => {
  it("when cleared after a save", () => {
    const key = formDraftKey(OWNER, ORG_A, "new-client");
    saveFormDraft(key, { displayName: "Rivera" });
    clearFormDraft(key);
    expect(loadFormDraft(key)).toBeNull();
  });

  it("when it is older than the time a draft is kept", () => {
    const key = formDraftKey(OWNER, ORG_A, "new-client");
    saveFormDraft(key, { displayName: "Rivera" }, 1_000);
    expect(loadFormDraft(key, 1_000 + FORM_DRAFT_TTL_MS + 1)).toBeNull();
    expect(local.getItem(key!)).toBeNull();
  });

  it("when what is stored cannot be read", () => {
    const key = formDraftKey(OWNER, ORG_A, "new-client")!;
    local.setItem(key, "{not json");
    expect(loadFormDraft(key)).toBeNull();
    expect(local.getItem(key)).toBeNull();
  });

  it("on sign-out, every one on the device and nothing else", () => {
    saveFormDraft(formDraftKey(OWNER, ORG_A, "new-client"), { a: 1 });
    saveFormDraft(formDraftKey(OFFICE, ORG_B, "setup-business"), { b: 1 });
    local.setItem("hs-theme", "dark");
    clearAllFormDrafts();
    expect([...Array(local.length).keys()].map((i) => local.key(i))).toEqual(["hs-theme"]);
    expect(FORM_DRAFT_PREFIX).toBe("hs:form-draft:");
  });

  it("an unchanged form is not a draft", () => {
    const opened = JSON.stringify({ name: null });
    expect(draftDiffers(opened, opened)).toBe(false);
    expect(draftDiffers(opened, JSON.stringify({ name: "Scoop Co" }))).toBe(true);
  });
});

describe("the wiring", () => {
  it("both sign-out paths drop the drafts", () => {
    const src = read("src/lib/offline/read-cache.ts");
    const fn = src.slice(src.indexOf("export async function signOutAndClearDevice"));
    expect(fn.slice(0, fn.indexOf("signOut(") + 1)).toMatch(/clearFormDraftsOnSignOut\(\)/);
    const backstop = src.slice(src.indexOf('event === "SIGNED_OUT"'));
    expect(backstop.slice(0, backstop.indexOf("unsubscribeAuth ="))).toMatch(
      /clearFormDraftsOnSignOut\(\)/,
    );
  });

  for (const [file, form] of [
    ["src/routes/_authenticated/setup.tsx", '"setup-business"'],
    ["src/routes/_authenticated/clients.new.tsx", "newClientDraftForm(fromLead, fromQuote)"],
  ] as const) {
    it(`${file} keeps a draft, offers Discard draft, and clears it on save`, () => {
      const src = read(file);
      expect(src).toContain(`form: ${form}`);
      expect(src).toMatch(
        /draft\.restored && <DraftRestoredNotice onDiscard=\{draft\.discard\} \/>/,
      );
      // setup.tsx saves through stepSave (src/lib/setup-step-save.ts), whose
      // `saved` runs from onSuccess, so it is the same moment under that name.
      const marker = file.endsWith("setup.tsx") ? "saved: () =>" : "onSuccess:";
      const success = src.slice(src.indexOf(marker));
      expect(success.slice(0, success.indexOf("toast.success"))).toMatch(/draft\.clear\(\)/);
    });
  }

  it("the notice's button is a real, touch-sized button that says Discard draft", () => {
    const src = read("src/components/DraftRestoredNotice.tsx");
    expect(src).toMatch(/<Button[^>]*size="sm"[^>]*>\s*Discard draft\s*<\/Button>/);
  });
});
