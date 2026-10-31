// A walk report survives Client info, a reload and the app being killed (#610).
//
// useWalkReport held pee, poo and the note in React state only. Open Client
// info, reload, or have the phone kill the app, and the card came back empty;
// End walk then sent nothing. The draft is now kept on the device per visit in
// its own IndexedDB database (src/lib/offline/walk-drafts.ts), read back on
// mount, and cleared once End walk has recorded the report or on reset.
//
// No DOM library is installed here, so "remount" is a second keeper for the
// same visit reading the same store, which is what a remounted card does.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── An IndexedDB that lives in a Map, and survives a "kill" ────────────────
const idb = vi.hoisted(() => ({
  drafts: new Map<string, { key: string }>(),
  opened: [] as string[],
}));
vi.mock("idb", () => ({
  openDB: async (name: string, version: number) => {
    idb.opened.push(`${name}@${version}`);
    return {
      get: async (_s: string, k: string) => idb.drafts.get(k),
      put: async (_s: string, v: { key: string }) => void idb.drafts.set(v.key, structuredClone(v)),
      delete: async (_s: string, k: string) => void idb.drafts.delete(k),
      clear: async () => void idb.drafts.clear(),
    };
  },
}));

const { createWalkDraftKeeper, clearAllWalkDrafts, confirmEndWithEmptyReport, walkDraftIsEmpty } =
  await import("@/lib/offline/walk-drafts");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const TECH_A = "11111111-1111-4111-8111-111111111111";
const TECH_B = "22222222-2222-4222-8222-222222222222";
const as = (userId: string) => async () => userId;

beforeEach(() => {
  idb.drafts.clear();
});

describe("a draft is kept per visit", () => {
  it("is saved as it is typed and read back by a remounted card", async () => {
    const card = createWalkDraftKeeper("visit-1", as(TECH_A));
    await card.save({ pee: true, poo: null, note: "Luna pulled at the corner" });

    // Client info, reload, or kill: the card is gone and a new one mounts.
    const again = createWalkDraftKeeper("visit-1", as(TECH_A));
    expect(await again.load()).toEqual({ pee: true, poo: null, note: "Luna pulled at the corner" });
  });

  it("keeps the last keystroke when writes are issued back to back", async () => {
    const card = createWalkDraftKeeper("visit-1", as(TECH_A));
    void card.save({ pee: null, poo: null, note: "H" });
    void card.save({ pee: null, poo: null, note: "Ha" });
    await card.save({ pee: null, poo: null, note: "Happy walk" });
    expect(await createWalkDraftKeeper("visit-1", as(TECH_A)).load()).toEqual({
      pee: null,
      poo: null,
      note: "Happy walk",
    });
  });

  it("does not let two visits share a draft", async () => {
    await createWalkDraftKeeper("visit-1", as(TECH_A)).save({ pee: true, poo: true, note: "one" });
    await createWalkDraftKeeper("visit-2", as(TECH_A)).save({ pee: false, poo: null, note: "two" });

    await createWalkDraftKeeper("visit-1", as(TECH_A)).clear();

    expect(await createWalkDraftKeeper("visit-1", as(TECH_A)).load()).toBeNull();
    expect(await createWalkDraftKeeper("visit-2", as(TECH_A)).load()).toEqual({
      pee: false,
      poo: null,
      note: "two",
    });
  });

  it("is read back only by the walker who typed it", async () => {
    await createWalkDraftKeeper("visit-1", as(TECH_A)).save({ pee: true, poo: null, note: "A" });
    expect(await createWalkDraftKeeper("visit-1", as(TECH_B)).load()).toBeNull();
  });

  it("an emptied report is a deleted draft", async () => {
    const card = createWalkDraftKeeper("visit-1", as(TECH_A));
    await card.save({ pee: true, poo: null, note: "" });
    await card.save({ pee: null, poo: null, note: "   " });
    expect(idb.drafts.size).toBe(0);
  });

  it("is cleared, and a clear issued after a save lands after it", async () => {
    const card = createWalkDraftKeeper("visit-1", as(TECH_A));
    void card.save({ pee: true, poo: true, note: "done" });
    await card.clear();
    expect(await createWalkDraftKeeper("visit-1", as(TECH_A)).load()).toBeNull();
  });

  it("keeps the report in memory only on a device that cannot say who is signed in", async () => {
    const card = createWalkDraftKeeper("visit-1", async () => {
      throw new Error("sign-in couldn't be confirmed");
    });
    await card.save({ pee: true, poo: null, note: "x" });
    expect(await card.load()).toBeNull();
    expect(idb.drafts.size).toBe(0);
  });

  it("sign-out's clear drops every draft on the device", async () => {
    await createWalkDraftKeeper("visit-1", as(TECH_A)).save({ pee: true, poo: null, note: "A" });
    await createWalkDraftKeeper("visit-2", as(TECH_B)).save({ pee: null, poo: true, note: "B" });
    await clearAllWalkDrafts();
    expect(idb.drafts.size).toBe(0);
  });

  it("lives in its own database and leaves the offline queue's version alone", async () => {
    await createWalkDraftKeeper("visit-1", as(TECH_A)).save({ pee: true, poo: null, note: "" });
    // Opened once for the whole file, and only ever this database.
    expect(idb.opened).toEqual(["scoop-walk-drafts@1"]);
    // A bump here blocks on every other open tab before it can upgrade, and
    // would put queued work at risk for a draft.
    expect(read("src/lib/offline/queue.ts")).toMatch(/openDB<OfflineDB>\("scoop-offline",\s*3/);
  });
});

describe("the walk card uses the draft", () => {
  const src = read("src/components/my-day/WalkParts.tsx");
  const hook = src.slice(src.indexOf("export function useWalkReport"), src.indexOf("/** Yes / No"));

  it("writes nothing until the saved draft has been read back", () => {
    expect(hook).toMatch(/if \(!hydrated\) return;\s*void keeper\.current\?\.save\(/);
  });

  it("lets a field the walker touched before the draft arrived keep what they typed", () => {
    expect(hook).toMatch(/if \(!touched\.current\.note\) setNoteState\(d\.note\)/);
  });

  it("clears the draft once the report is recorded, and on reset", () => {
    const send = hook.slice(hook.indexOf("const send"), hook.indexOf("const reset"));
    expect(send.indexOf("keeper.current?.clear()")).toBeGreaterThan(
      send.indexOf("await runOrQueue("),
    );
    const reset = hook.slice(hook.indexOf("const reset"));
    expect(reset).toMatch(/keeper\.current\?\.clear\(\)/);
  });
});

describe("End walk with an empty report warns, and never blocks", () => {
  const empty = { pee: null, poo: null, note: "" };

  it("asks when pee, poo and the note are all unset", async () => {
    const ask = vi.fn(async () => true);
    expect(await confirmEndWithEmptyReport(empty, ask)).toBe(true);
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("cancel keeps the walk open to fill the report in", async () => {
    expect(await confirmEndWithEmptyReport({ ...empty, note: "  " }, async () => false)).toBe(
      false,
    );
  });

  it("does not ask when anything is recorded, a No included", async () => {
    const ask = vi.fn(async () => false);
    for (const r of [
      { ...empty, pee: false },
      { ...empty, poo: true },
      { ...empty, note: "Good walk" },
    ]) {
      expect(walkDraftIsEmpty(r)).toBe(false);
      expect(await confirmEndWithEmptyReport(r, ask)).toBe(true);
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it("is wired to End walk on a walk card, with the confirm ending and cancel returning", () => {
    const route = read("src/routes/_authenticated/my-day.tsx");
    const tap = route.slice(
      route.indexOf("const tapStep = async () =>"),
      route.indexOf("void runVisitStep(step,"),
    );
    expect(tap).toMatch(
      /step === "complete" &&\s*walk &&\s*!\(await confirmEndWithEmptyReport\(walkReport,[\s\S]*\)\s*return;\s*$/,
    );
    expect(route).toMatch(/complete: \(\) => complete\.mutate\(\)/);
    expect(route).toMatch(/\{walk && endWalkDialog\}/);
  });
});
