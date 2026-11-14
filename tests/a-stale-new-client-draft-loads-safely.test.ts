// #784, the second time: a new-client draft kept by an older build restored
// `undefined` into fields the wizard calls `.trim()` on, and Create client
// failed with "Cannot read properties of undefined (reading 'trim')" until
// the owner discarded the draft. The browser half, which creates the client
// against a real database, is
// tests/e2e/a-stale-new-client-draft-still-creates-a-client.spec.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createFailedMessage, FORM_THREW_MESSAGE } from "@/lib/create-client-error";
import { clearFormDraft, formDraftKey, loadFormDraft, saveFormDraft } from "@/lib/form-drafts";
import { BLANK_DOG } from "@/lib/lead-conversion";
import { normalizeNewClientDraft, type NewClientDraft } from "@/lib/new-client-draft";

/** How the wizard opens for a client typed in by hand. */
const OPENED: NewClientDraft = {
  step: 0,
  groomInstead: false,
  displayName: "",
  accountType: "residential",
  primaryEmail: "",
  primaryPhone: "",
  officeNote: "",
  street: "",
  city: "",
  region: "",
  postalCode: "",
  accessNotes: "",
  parkingNotes: "",
  hazardNotes: "",
  vcName: "",
  vcPhone: "",
  vcEmail: "",
  hz: { aggressiveDog: false, escapeRisk: false },
  boundary: null,
  geo: null,
  dogs: [{ ...BLANK_DOG }],
  frequency: "weekly",
  billingCadence: "postpaid",
  unitCount: "1",
  stationCount: "",
  priceOverride: "",
  skipPlan: null,
  startedOn: "2026-11-12",
  serviceDays: null,
  serviceId: "",
  weekdays: null,
  fcChoice: "",
  fcOverride: "",
};

const LAST_STEP = 4;

/** A draft in the old shape: no primaryEmail, accessNotes, officeNote, nor
 *  anything added after them, kept on step 2, as the tester's was. */
function oldShapeDraft(name: string) {
  return {
    step: 2,
    displayName: name,
    accountType: "residential",
    primaryPhone: "",
    street: "200 Test Ave",
    city: "Lansing",
    region: "MI",
    postalCode: "48933",
    dogs: [{ name: "Testdog2", breed: "", weightClass: "" }],
    frequency: "weekly",
    priceOverride: "",
  };
}

/** What Create client reads from the restored form before the request goes:
 *  the same `.trim()` calls clients.new.tsx makes, without its `?? ""` guard,
 *  so a field the normalizer leaves undefined throws here exactly as it did
 *  on the live app. */
function createPayloadText(d: NewClientDraft) {
  return {
    displayName: d.displayName,
    sendWelcome: !!d.primaryEmail.trim(),
    accessNotes: d.accessNotes.trim() || undefined,
    officeNote: d.officeNote.trim() || undefined,
    postalCode: d.postalCode.trim(),
    dogs: d.dogs.filter((x) => x.name.trim()).map((x) => x.name.trim()),
  };
}

// A minimal localStorage, so the draft goes through the same save and load
// the wizard uses.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, String(v)),
  };
}

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: memoryStorage() });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a stale new-client draft", () => {
  const key = formDraftKey("user-1", "org-1", "new-client");

  it("the unguarded payload throws the live error on the raw old draft", () => {
    // The fault as it shipped, so the fix below is measured against it.
    const raw = oldShapeDraft("Client 2") as unknown as NewClientDraft;
    expect(() => createPayloadText(raw)).toThrow(/reading 'trim'/);
  });

  it("loads with every field the wizard holds, of the type it holds", () => {
    saveFormDraft(key, oldShapeDraft("QA Test Client 2 (fake)"));
    const d = normalizeNewClientDraft(loadFormDraft(key), OPENED, LAST_STEP);
    expect(d).not.toBeNull();
    for (const [k, v] of Object.entries(OPENED)) {
      expect(typeof d![k as keyof NewClientDraft], k).toBe(typeof v);
    }
    // What the draft did have is kept.
    expect(d!.step).toBe(2);
    expect(d!.displayName).toBe("QA Test Client 2 (fake)");
    expect(d!.postalCode).toBe("48933");
    expect(d!.dogs).toEqual([{ ...BLANK_DOG, name: "Testdog2" }]);
    // What it lacked is how the form opened.
    expect(d!.primaryEmail).toBe("");
    expect(d!.accessNotes).toBe("");
    expect(d!.officeNote).toBe("");
    expect(d!.unitCount).toBe("1");
    expect(d!.hz).toEqual(OPENED.hz);
  });

  it("then a second client's create reads no undefined", () => {
    // Client 1: typed fresh, created, draft cleared.
    saveFormDraft(key, { ...OPENED, displayName: "Client 1", primaryEmail: "c1@example.test" });
    const first = normalizeNewClientDraft(loadFormDraft(key), OPENED, LAST_STEP)!;
    expect(createPayloadText(first).sendWelcome).toBe(true);
    clearFormDraft(key);
    expect(loadFormDraft(key)).toBeNull();

    // Client 2: the wizard reopens on a draft in the old shape, no email.
    saveFormDraft(key, oldShapeDraft("Client 2"));
    const second = normalizeNewClientDraft(loadFormDraft(key), OPENED, LAST_STEP)!;
    expect(createPayloadText(second)).toEqual({
      displayName: "Client 2",
      sendWelcome: false,
      accessNotes: undefined,
      officeNote: undefined,
      postalCode: "48933",
      dogs: ["Testdog2"],
    });
  });

  it.each([
    ["null strings", { displayName: null, primaryEmail: null, officeNote: 5 }],
    ["a step past the end", { step: 9 }],
    ["a negative step", { step: -1 }],
    ["dogs that are not dogs", { dogs: [null, "Rex", { name: 3 }] }],
    ["no dogs", { dogs: [] }],
    ["a frequency nobody sells", { frequency: "hourly" }],
    ["a bad date", { startedOn: "tomorrow" }],
    ["weekdays out of range", { weekdays: [1, 9], serviceDays: "mon" }],
    ["a broken pin and boundary", { geo: { lat: "x" }, boundary: { type: "Point" } }],
    ["hazards that are not booleans", { hz: { aggressiveDog: "yes", invented: true } }],
  ])("with %s still loads as a form that submits", (_, partial) => {
    const d = normalizeNewClientDraft({ ...oldShapeDraft("X"), ...partial }, OPENED, LAST_STEP)!;
    expect(() => createPayloadText(d)).not.toThrow();
    expect(d.step).toBeGreaterThanOrEqual(0);
    expect(d.step).toBeLessThanOrEqual(LAST_STEP);
    expect(d.dogs.length).toBeGreaterThan(0);
    expect(["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]).toContain(d.frequency);
    expect(d.startedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Object.keys(d.hz).sort()).toEqual(Object.keys(OPENED.hz).sort());
    for (const v of Object.values(d.hz)) expect(typeof v).toBe("boolean");
    if (d.geo) expect(Number.isFinite(d.geo.lat)).toBe(true);
  });

  it("something that is not a draft is not restored", () => {
    expect(normalizeNewClientDraft(null, OPENED, LAST_STEP)).toBeNull();
    expect(normalizeNewClientDraft("draft", OPENED, LAST_STEP)).toBeNull();
    expect(normalizeNewClientDraft([1, 2], OPENED, LAST_STEP)).toBeNull();
  });
});

describe("the wizard restores through the normalizer", () => {
  const src = readFileSync(
    join(__dirname, "..", "src", "routes", "_authenticated", "clients.new.tsx"),
    "utf8",
  );

  it("restore reads the draft only through normalizeNewClientDraft", () => {
    const restore = src.slice(src.indexOf("restore: (raw) =>"), src.indexOf("reset: onDiscarded"));
    expect(restore).toContain("normalizeNewClientDraft(raw,");
    // No setter is handed the raw draft.
    expect(restore).not.toMatch(/\(raw\.\w+\)/);
  });
});

describe("a failure in the form itself says what to do", () => {
  it.each([
    "Cannot read properties of undefined (reading 'trim')",
    "undefined is not an object (evaluating 'e.trim')",
    'can\'t access property "trim", e is undefined',
  ])("%s", (msg) => {
    const text = createFailedMessage(new TypeError(msg), msg);
    expect(text).toBe(FORM_THREW_MESSAGE);
    expect(text).toMatch(/did not finish/);
    expect(text).toMatch(/discard draft/i);
    expect(text).not.toMatch(/trim|undefined/);
  });

  it("a network failure is still a network failure", () => {
    expect(createFailedMessage(new TypeError("Failed to fetch"))).toMatch(/check clients/i);
  });

  it("the server's own reason still passes through", () => {
    expect(createFailedMessage(new Error("Plan ended"), "Plan ended")).toBe(
      "Create client did not finish. Plan ended",
    );
  });
});
