// #784, Nov 10 2026 retest. A second client with NO email, the
// draft-restored banner on screen, Create client on Plan:
//
//   "Create client did not finish. Cannot read properties of undefined
//    (reading 'trim')"
//
// The wizard keeps what was typed in localStorage and hands it back through
// useFormDraft's `restore`. What comes back is whatever JSON was stored, and a
// key the stored draft never had comes back `undefined`. The wizard set that
// straight into its text state, then called `primaryEmail.trim()` to decide
// the welcome email, `accessNotes.trim()` and `officeNote.trim()` building
// the payload, and `primaryEmail.trim()` again to draw WelcomeEmailOptIn. The
// server already read it as `data.primaryEmail?.trim()`; the wizard did not.
//
// Two halves, either of which alone fixes the crash:
//   1. a restored draft's text fields are strings (lib/new-client-draft);
//   2. the wizard's trims do not assume they are.
// The browser half, which presses Create client after a real reload with the
// keys removed from the stored draft, is
// tests/e2e/a-second-client-with-a-manual-price-is-created.spec.ts.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { NEW_CLIENT_DRAFT_TEXT_DEFAULTS, withNewClientDraftDefaults } from "@/lib/new-client-draft";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const WIZARD = "src/routes/_authenticated/clients.new.tsx";

/** What the tester's device held: a draft on the Plan step, the second
 *  client's name, address, dog and $20, and no email / access note / office
 *  note key at all. */
const STORED_WITHOUT_EMAIL = {
  step: 4,
  groomInstead: true,
  displayName: "QA Test Client 2 (fake)",
  accountType: "residential",
  primaryPhone: "",
  street: "200 Test Ave",
  city: "Lansing",
  region: "MI",
  postalCode: "48933",
  parkingNotes: "",
  hazardNotes: "",
  vcName: "",
  vcPhone: "",
  vcEmail: "",
  dogs: [{ name: "Testdog2", breed: "", weightClass: "", temperament: "friendly", notes: "" }],
  frequency: "weekly",
  billingCadence: "postpaid",
  unitCount: "1",
  stationCount: "",
  priceOverride: "$20",
  skipPlan: null,
  serviceDays: null,
  serviceId: "",
  weekdays: null,
  fcChoice: "",
  fcOverride: "",
};

describe("a restored new-client draft", () => {
  const restored = withNewClientDraftDefaults(
    JSON.parse(JSON.stringify(STORED_WITHOUT_EMAIL)) as Record<string, unknown>,
  );

  it.each(["primaryEmail", "accessNotes", "officeNote"])(
    "with no %s key comes back with an empty string, which trims",
    (field) => {
      expect(restored[field]).toBe("");
      expect(() => (restored[field] as string).trim()).not.toThrow();
    },
  );

  it("every wizard text field is a string, whatever the stored draft had", () => {
    const junk: Record<string, unknown> = { step: 2 };
    for (const f of Object.keys(NEW_CLIENT_DRAFT_TEXT_DEFAULTS)) junk[f] = null;
    junk.displayName = 42;
    const out = withNewClientDraftDefaults(junk);
    for (const [f, empty] of Object.entries(NEW_CLIENT_DRAFT_TEXT_DEFAULTS)) {
      expect(typeof out[f], f).toBe("string");
      expect(out[f], f).toBe(empty);
    }
    expect(withNewClientDraftDefaults({} as Record<string, unknown>).unitCount).toBe("1");
  });

  it("keeps everything the person did type", () => {
    for (const [k, v] of Object.entries(STORED_WITHOUT_EMAIL)) expect(restored[k], k).toEqual(v);
    const withEmail = withNewClientDraftDefaults({
      ...STORED_WITHOUT_EMAIL,
      primaryEmail: "client@example.test",
      officeNote: "Side gate",
    } as Record<string, unknown>);
    expect(withEmail.primaryEmail).toBe("client@example.test");
    expect(withEmail.officeNote).toBe("Side gate");
  });

  it("a dog row stored without a name is a blank row, not a crash", () => {
    const out = withNewClientDraftDefaults({
      dogs: [{ breed: "Lab" }, { name: "Bailey" }],
    } as Record<string, unknown>);
    expect(out.dogs).toEqual([{ breed: "Lab", name: "" }, { name: "Bailey" }]);
  });

  it("leaves a draft with no dogs key alone (the wizard keeps its own rows)", () => {
    expect("dogs" in withNewClientDraftDefaults({ step: 1 } as Record<string, unknown>)).toBe(
      false,
    );
  });
});

describe("the wizard", () => {
  const src = read(WIZARD);

  it("restores a draft through withNewClientDraftDefaults", () => {
    const restore = src.slice(src.indexOf("restore: ("), src.indexOf("reset: onDiscarded"));
    expect(restore).toMatch(/const d = withNewClientDraftDefaults\(\w+\);/);
    // Before any setter reads it.
    expect(restore.indexOf("withNewClientDraftDefaults")).toBeLessThan(restore.indexOf("set"));
  });

  it.each(["primaryEmail", "accessNotes", "officeNote", "postalCode", "displayName"])(
    "never calls %s.trim() on a value it has not guarded",
    (field) => {
      const unguarded = src
        .split("\n")
        .map((line, i) => ({ line, n: i + 1 }))
        .filter(({ line }) => new RegExp(`(?<![?\\w])${field}\\.trim\\(\\)`).test(line));
      expect(unguarded.map(({ n, line }) => `${WIZARD}:${n}: ${line.trim()}`)).toEqual([]);
    },
  );

  it("draws the welcome-email box only for an email that is there", () => {
    expect(src).toContain("primaryEmail?.trim() && (");
    expect(src).toContain('email={primaryEmail?.trim() ?? ""}');
    expect(src).toContain("!!primaryEmail?.trim()");
  });
});
