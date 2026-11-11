// @vitest-environment happy-dom
//
// #770: setup step 1, reopened after both service lines were saved, showed
// "We kept what you typed here last time on this device" and Pet waste
// removal UNTICKED. A device draft (useFormDraft, gaps-r2-12) is
// null-means-untouched, so a stale draft whose `lines` was ["dog_walking"]
// won over the saved answer through `lines ?? startingLines`.
//
// Driven here the way step 1 drives it: the real useFormDraft, the real
// reconcileSetupBusinessDraft, the real ServiceLinesChoices and
// DraftRestoredNotice, wired the way BusinessPanel wires them (the last block
// pins that wiring in the route's source). Ticks are clicks on the boxes.
//
// Run against the old reading (the draft restored whole), five of these fail,
// the stale partial draft first: pet_waste unchecked, the banner on screen.

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
vi.mock("@/hooks/useServiceLineAvailability", async () => {
  const { OFFERED_SERVICE_LINES } = await import("@/lib/service-lines");
  return {
    useServiceLineAvailability: () => ({
      bookable: [...OFFERED_SERVICE_LINES],
      customerRequestable: [...OFFERED_SERVICE_LINES],
    }),
  };
});

import { useFormDraft } from "@/hooks/useFormDraft";
import { ServiceLinesChoices } from "@/components/ServiceLinesChoices";
import { DraftRestoredNotice } from "@/components/DraftRestoredNotice";
import { formDraftKey, loadFormDraft, saveFormDraft } from "@/lib/form-drafts";
import {
  linesWithSaved,
  reconcileSetupBusinessDraft,
  setupBusinessStored,
  type SetupBusinessDraft,
} from "@/lib/setup-business-draft";
import type { ServiceLine } from "@/lib/service-lines";

const KEY = formDraftKey(USER, ORG, "setup-business")!;
const STORED = setupBusinessStored(
  {
    name: "Onboarding QA Pet Co 1109",
    contact_phone: "313-555-0142",
    contact_address: "1 Main St",
  },
  { timezone: "America/Detroit", workday_start: "08:00:00", workday_end: "17:00:00" },
  "onboarding-qa-pet-co",
);

/** Step 1's lines and name, wired as BusinessPanel wires them. */
function StepOne(props: {
  alreadyDone: boolean;
  savedLines: ServiceLine[];
  onSave: (lines: ServiceLine[]) => void;
}) {
  const { alreadyDone, savedLines } = props;
  const [lines, setLines] = useState<ServiceLine[] | null>(null);
  const [name, setName] = useState<string | null>(null);
  const draft = useFormDraft<SetupBusinessDraft>({
    form: "setup-business",
    value: { lines, name, phone: null, address: null, tz: null },
    ready: true,
    restore: (saved) => {
      const d = reconcileSetupBusinessDraft(saved, {
        alreadyDone,
        savedLines,
        linesKnown: true,
        stored: STORED,
      });
      if (!d) return false;
      setLines(d.lines);
      setName(d.name);
    },
    reset: () => {
      setLines(null);
      setName(null);
    },
  });
  // A business that has not answered starts with nothing ticked (F-06).
  const linesVal = lines ?? (alreadyDone ? savedLines : []);
  return (
    <form>
      {draft.restored && <DraftRestoredNotice onDiscard={draft.discard} />}
      <ServiceLinesChoices idPrefix="setup-service-line" lines={linesVal} onChange={setLines} />
      <input data-name value={name ?? STORED.name} onChange={(e) => setName(e.target.value)} />
      <button
        type="button"
        data-save
        onClick={() => {
          props.onSave(linesVal);
          draft.clear();
        }}
      />
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

const box = (line: ServiceLine) =>
  host.querySelector<HTMLButtonElement>(`#setup-service-line-${line}`)!;
const checked = (line: ServiceLine) => box(line).getAttribute("aria-checked") === "true";
const banner = () => host.querySelector("[data-draft-restored]");

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
}

beforeEach(() => localStorage.clear());
afterEach(() => close());

describe("#770: reopening step 1 after both lines were saved", () => {
  it("saves both lines, reopens step 1, and shows both ticked with no draft banner", async () => {
    let saved: ServiceLine[] = [];
    await open({ alreadyDone: false, savedLines: ["pet_waste"], onSave: (l) => (saved = l) });
    expect(checked("dog_walking")).toBe(false);
    expect(checked("pet_waste")).toBe(false);

    await click(box("dog_walking"));
    // Half way: a draft with one line is on the device, as the bug had it.
    expect(loadFormDraft<SetupBusinessDraft>(KEY)?.lines).toEqual(["dog_walking"]);
    await click(box("pet_waste"));
    expect(checked("dog_walking")).toBe(true);
    expect(checked("pet_waste")).toBe(true);

    await click(host.querySelector("[data-save]")!);
    expect([...saved].sort()).toEqual(["dog_walking", "pet_waste"]);
    expect(loadFormDraft(KEY)).toBeNull();
    close();

    // Reopen /setup?step=business: the step is done, both lines stored.
    await open({ alreadyDone: true, savedLines: saved, onSave: () => undefined });
    expect(checked("dog_walking")).toBe(true);
    expect(checked("pet_waste")).toBe(true);
    expect(banner()).toBeNull();
  });

  it("a stale partial draft cannot untick a saved line, and is no draft at all", async () => {
    // The draft written mid-way, outliving the save it led to.
    saveFormDraft(KEY, {
      lines: ["dog_walking"],
      name: null,
      phone: null,
      address: null,
      tz: null,
    });
    await open({
      alreadyDone: true,
      savedLines: ["pet_waste", "dog_walking"],
      onSave: () => undefined,
    });
    expect(checked("pet_waste")).toBe(true);
    expect(checked("dog_walking")).toBe(true);
    expect(banner()).toBeNull();
    // Dropped, so it cannot come back on the next visit either.
    expect(loadFormDraft(KEY)).toBeNull();
  });

  it("a draft that repeats the saved name is no draft either", async () => {
    saveFormDraft(KEY, {
      lines: ["pet_waste", "dog_walking"],
      name: STORED.name,
      phone: null,
      address: null,
      tz: null,
    });
    await open({
      alreadyDone: true,
      savedLines: ["dog_walking", "pet_waste"],
      onSave: () => undefined,
    });
    expect(banner()).toBeNull();
  });

  it("a real unsaved change is still offered back, with every saved line kept", async () => {
    saveFormDraft(KEY, {
      lines: ["dog_walking"],
      name: "New name",
      phone: null,
      address: null,
      tz: null,
    });
    await open({
      alreadyDone: true,
      savedLines: ["pet_waste", "dog_walking"],
      onSave: () => undefined,
    });
    expect(banner()).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>("[data-name]")!.value).toBe("New name");
    expect(checked("pet_waste")).toBe(true);
    expect(checked("dog_walking")).toBe(true);
  });

  it("Discard draft returns to the server-saved lines, not an empty list", async () => {
    saveFormDraft(KEY, {
      lines: ["dog_walking", "pet_sitting"],
      name: "New name",
      phone: null,
      address: null,
      tz: null,
    });
    await open({
      alreadyDone: true,
      savedLines: ["pet_waste", "dog_walking"],
      onSave: () => undefined,
    });
    // A line the draft ADDED is kept.
    expect(checked("pet_sitting")).toBe(true);
    await click(banner()!.querySelector("button")!);
    expect(banner()).toBeNull();
    expect(checked("pet_waste")).toBe(true);
    expect(checked("dog_walking")).toBe(true);
    expect(checked("pet_sitting")).toBe(false);
    expect(host.querySelector<HTMLInputElement>("[data-name]")!.value).toBe(STORED.name);
    expect(loadFormDraft(KEY)).toBeNull();
  });

  it("before the first save, a reload keeps the lines as they were ticked (gaps-r2-12)", async () => {
    saveFormDraft(KEY, {
      lines: ["dog_walking"],
      name: null,
      phone: null,
      address: null,
      tz: null,
    });
    await open({ alreadyDone: false, savedLines: ["pet_waste"], onSave: () => undefined });
    expect(banner()).not.toBeNull();
    expect(checked("dog_walking")).toBe(true);
    expect(checked("pet_waste")).toBe(false);
  });
});

describe("reconcileSetupBusinessDraft", () => {
  const ctx = {
    alreadyDone: true,
    savedLines: ["pet_waste", "dog_walking"] as ServiceLine[],
    linesKnown: true,
    stored: STORED,
  };
  const empty = { lines: null, name: null, phone: null, address: null, tz: null };

  it("keeps every saved line in a done step's draft", () => {
    expect(linesWithSaved(["dog_walking"], ["pet_waste", "dog_walking"])).toEqual([
      "pet_waste",
      "dog_walking",
    ]);
    expect(reconcileSetupBusinessDraft({ ...empty, lines: ["dog_walking"] }, ctx)).toBeNull();
  });

  it("does not weigh lines it cannot read yet", () => {
    expect(
      reconcileSetupBusinessDraft(
        { ...empty, lines: ["dog_walking"] },
        { ...ctx, linesKnown: false },
      )?.lines,
    ).toEqual(["dog_walking"]);
  });

  it("treats a stored zone, workday, email or portal address as untouched", () => {
    expect(
      reconcileSetupBusinessDraft(
        {
          ...empty,
          tz: "America/Detroit",
          dayStart: "08:00",
          dayEnd: "17:00",
          officeEmail: "",
          portalSlug: "onboarding-qa-pet-co",
          phone: "313-555-0142",
          address: "1 Main St",
        },
        ctx,
      ),
    ).toBeNull();
  });

  it("keeps a zone typed before the first save, when there is nothing stored to weigh it against", () => {
    expect(
      reconcileSetupBusinessDraft(
        { ...empty, tz: "America/Detroit" },
        { ...ctx, alreadyDone: false },
      )?.tz,
    ).toBe("America/Detroit");
  });
});

describe("the route wires it that way", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src/routes/_authenticated/setup.tsx"),
    "utf8",
  );
  const block = src.slice(src.indexOf('form: "setup-business"'), src.indexOf("reset: () =>"));

  it("waits for the saved answer before reading a draft back", () => {
    expect(block).toMatch(/ready: linesKnown && !brandingQ\.isPending && !dispatchQ\.isPending/);
  });

  it("reads the draft back through reconcileSetupBusinessDraft, and drops an empty one", () => {
    expect(block).toMatch(/reconcileSetupBusinessDraft\(saved, ctx\)/);
    expect(block).toMatch(/if \(!d\) return false;/);
    expect(block).toMatch(/alreadyDone, savedLines, linesKnown, stored/);
  });
});
