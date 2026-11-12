// @vitest-environment happy-dom
//
// #787, the display half. Sign-up fills organizations.contact_phone with the
// owner's mobile, and setup step 1 shows it as Business phone. Step 1 also
// keeps what is typed on the device (useFormDraft, gaps-r2-12), and a draft
// that held an interrupted keystroke, "555-", was read back whole and shown
// OVER the stored number. The server refuses to SAVE the fragment (#811),
// so nothing was lost, but the owner saw "555-" where their number should
// be and read it as lost.
//
// The rule, in reconcileSetupBusinessDraft: a kept phone that is not a whole
// number (setupBusinessPhonePrefill, phone-handoff.ts) does not cover a
// stored whole number. It is dropped, so the stored number shows, there is
// no "we kept what you typed" banner, and the draft cannot come back on the
// next visit. A whole number typed on this device still wins, a field the
// owner cleared stays cleared, and a fragment with nothing stored is kept
// as typed (the reload gaps-r2-12 was for).
//
// Driven the way step 1 drives it: the real useFormDraft, the real
// reconcileSetupBusinessDraft and DraftRestoredNotice, wired as BusinessPanel
// wires them (the last block pins that wiring in the route's source). Run
// against the previous reconcile (phone read back as any other field), the
// first case fails with "555-" in the field and the banner on screen.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

vi.mock("@/hooks/useMyRole", () => ({ useMyRole: () => ({ orgId: ORG }) }));
vi.mock("@/lib/offline/action-owner", () => ({ resolveOfflineUserId: async () => USER }));

import { useFormDraft } from "@/hooks/useFormDraft";
import { DraftRestoredNotice } from "@/components/DraftRestoredNotice";
import { formDraftKey, loadFormDraft, saveFormDraft } from "@/lib/form-drafts";
import {
  reconcileSetupBusinessDraft,
  setupBusinessStored,
  type SetupBusinessDraft,
  type SetupBusinessStored,
} from "@/lib/setup-business-draft";

const KEY = formDraftKey(USER, ORG, "setup-business")!;
const SIGNUP_MOBILE = "313-555-0142";

/** What getOrgBranding answers right after sign-up: the mobile is the
 *  business phone, and step 1 has not been saved yet. */
const stored = (phone: string | null): SetupBusinessStored =>
  setupBusinessStored(
    { name: "QA TEST Tester Nov 9 2026", contact_phone: phone, contact_address: "1 Main St" },
    { timezone: "America/Detroit", workday_start: "08:00:00", workday_end: "17:00:00" },
    "qa-test-tester",
  );

const EMPTY: SetupBusinessDraft = { lines: null, name: null, phone: null, address: null, tz: null };

/** Step 1's Business phone, wired as BusinessPanel wires it. */
function StepOne({
  storedPhone,
  alreadyDone,
}: {
  storedPhone: string | null;
  alreadyDone: boolean;
}) {
  const [phone, setPhone] = useState<string | null>(null);
  const draft = useFormDraft<SetupBusinessDraft>({
    form: "setup-business",
    value: { ...EMPTY, phone },
    ready: true,
    restore: (saved) => {
      const d = reconcileSetupBusinessDraft(saved, {
        alreadyDone,
        savedLines: ["pet_waste"],
        linesKnown: true,
        stored: stored(storedPhone),
      });
      if (!d) return false;
      setPhone(d.phone);
    },
    reset: () => setPhone(null),
  });
  const phoneVal = phone ?? storedPhone ?? "";
  return (
    <form>
      {draft.restored && <DraftRestoredNotice onDiscard={draft.discard} />}
      <input id="setup-phone" value={phoneVal} onChange={(e) => setPhone(e.target.value)} />
    </form>
  );
}

let host: HTMLElement;
let root: Root | null = null;

async function open(props: Parameters<typeof StepOne>[0]) {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<StepOne {...props} />);
  });
  // resolveOfflineUserId is a promise: let the key arrive and the draft load.
  await act(async () => {
    await Promise.resolve();
  });
}

function close() {
  act(() => root?.unmount());
  root = null;
  host?.remove();
}

const phoneField = () => host.querySelector<HTMLInputElement>("#setup-phone")!;
const banner = () => host.querySelector("[data-draft-restored]");
const keep = (phone: string | null) => saveFormDraft(KEY, { ...EMPTY, phone });

beforeEach(() => localStorage.clear());
afterEach(() => close());

describe("#787: a kept phone fragment and the number sign-up stored", () => {
  it("shows the stored number, not '555-', with no draft banner, and drops the fragment", async () => {
    keep("555-");
    await open({ storedPhone: SIGNUP_MOBILE, alreadyDone: false });
    expect(phoneField().value).toBe(SIGNUP_MOBILE);
    expect(banner()).toBeNull();
    expect(loadFormDraft(KEY)).toBeNull();
  });

  it("the same once step 1 has been saved and reopened", async () => {
    keep("555-");
    await open({ storedPhone: SIGNUP_MOBILE, alreadyDone: true });
    expect(phoneField().value).toBe(SIGNUP_MOBILE);
    expect(banner()).toBeNull();
  });

  it("a whole number typed on this device still wins over the stored one", async () => {
    keep("248-555-0000");
    await open({ storedPhone: SIGNUP_MOBILE, alreadyDone: false });
    expect(phoneField().value).toBe("248-555-0000");
    expect(banner()).not.toBeNull();
  });

  it("a field the owner cleared stays cleared", async () => {
    keep("");
    await open({ storedPhone: SIGNUP_MOBILE, alreadyDone: false });
    expect(phoneField().value).toBe("");
    expect(banner()).not.toBeNull();
  });

  it("a fragment is kept when nothing is stored, so a reload mid-keystroke loses nothing", async () => {
    keep("555-");
    await open({ storedPhone: null, alreadyDone: false });
    expect(phoneField().value).toBe("555-");
    expect(banner()).not.toBeNull();
  });

  it("Discard draft on a kept whole number returns to the stored one", async () => {
    keep("248-555-0000");
    await open({ storedPhone: SIGNUP_MOBILE, alreadyDone: false });
    await act(async () => {
      banner()!.querySelector("button")!.click();
    });
    expect(phoneField().value).toBe(SIGNUP_MOBILE);
    expect(banner()).toBeNull();
  });
});

describe("reconcileSetupBusinessDraft, the phone", () => {
  const ctx = (phone: string | null) => ({
    alreadyDone: false,
    savedLines: ["pet_waste"] as const,
    linesKnown: true,
    stored: stored(phone),
  });

  it("drops a fragment over a stored whole number, and the whole draft with it", () => {
    expect(reconcileSetupBusinessDraft({ ...EMPTY, phone: "555-" }, ctx(SIGNUP_MOBILE))).toBeNull();
    expect(
      reconcileSetupBusinessDraft({ ...EMPTY, phone: "(313) " }, ctx(SIGNUP_MOBILE)),
    ).toBeNull();
  });

  it("keeps the rest of a draft whose phone was a fragment", () => {
    const d = reconcileSetupBusinessDraft(
      { ...EMPTY, phone: "555-", name: "New name" },
      ctx(SIGNUP_MOBILE),
    );
    expect(d).toMatchObject({ name: "New name", phone: null });
  });

  it("keeps a whole number, a cleared field, and a fragment over nothing", () => {
    expect(
      reconcileSetupBusinessDraft({ ...EMPTY, phone: "248-555-0000" }, ctx(SIGNUP_MOBILE))?.phone,
    ).toBe("248-555-0000");
    expect(reconcileSetupBusinessDraft({ ...EMPTY, phone: "" }, ctx(SIGNUP_MOBILE))?.phone).toBe(
      "",
    );
    expect(reconcileSetupBusinessDraft({ ...EMPTY, phone: "555-" }, ctx(null))?.phone).toBe("555-");
    expect(reconcileSetupBusinessDraft({ ...EMPTY, phone: "555-" }, ctx(""))?.phone).toBe("555-");
  });

  it("a stored fragment is not a whole number to keep either: the draft's own fragment shows", () => {
    // Nothing better to show, so the typed value stays (the server refuses
    // to store a fragment since #811; this is the belt for an older row).
    expect(reconcileSetupBusinessDraft({ ...EMPTY, phone: "555-" }, ctx("248-"))?.phone).toBe(
      "555-",
    );
  });

  it("a phone equal to the stored one is the stored one, not a draft", () => {
    expect(
      reconcileSetupBusinessDraft({ ...EMPTY, phone: SIGNUP_MOBILE }, ctx(SIGNUP_MOBILE)),
    ).toBeNull();
  });
});

describe("the route wires it that way", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src/routes/_authenticated/setup.tsx"),
    "utf8",
  );
  const block = src.slice(src.indexOf('form: "setup-business"'), src.indexOf("reset: () =>"));

  it("reads the phone back only through reconcileSetupBusinessDraft", () => {
    expect(block).toMatch(/reconcileSetupBusinessDraft\(saved, ctx\)/);
    expect(block).toMatch(/setPhone\(d\.phone\)/);
  });

  it("and the field shows the draft, else what is stored", () => {
    expect(src).toMatch(/const phoneVal = phone \?\? b\?\.contact_phone \?\? "";/);
  });

  it("the reconcile weighs the phone with the sign-up handoff's own rule", () => {
    const lib = readFileSync(
      join(import.meta.dirname, "..", "src/lib/setup-business-draft.ts"),
      "utf8",
    );
    expect(lib).toMatch(/import \{ setupBusinessPhonePrefill \} from "@\/lib\/phone-handoff"/);
    expect(lib).toMatch(/setupBusinessPhonePrefill\(draft\.phone, stored\.phone\)/);
  });
});
