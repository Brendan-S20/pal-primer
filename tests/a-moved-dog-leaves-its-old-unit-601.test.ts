// Units tab: a dog moved to another unit shows on the new unit and leaves the
// old one without a reload (#601).
//
// Both unit lists are ["client-dogs", clientId] filtered by unit_id. These run
// against a real QueryClient with mounted observers, the way the tab holds the
// two queries, and a read that answers with the rows from before the move.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyDogMove } from "@/lib/unit-dog-move";

const CLIENT = "c1";
const A = "unit-a";
const B = "unit-b";
const before = () => ({
  dogs: [
    { id: "pip", name: "Pip", unit_id: A, active: true },
    { id: "rex", name: "Rex", unit_id: A, active: true },
    { id: "bo", name: "Bo", unit_id: B, active: true },
  ],
});
const unitsData = () => ({ units: [{ id: A }, { id: B }], incidents: [], reviewDogs: [] });

const onUnit = (qc: QueryClient, unitId: string) =>
  (qc.getQueryData<ReturnType<typeof before>>(["client-dogs", CLIENT])?.dogs ?? [])
    .filter((d) => d.unit_id === unitId)
    .map((d) => d.id)
    .sort();

let qc: QueryClient;
let stop: Array<() => void> = [];

/** The tab's two queries, mounted. dogsFn answers every read with the rows
 * from before the move: the slowest a read can be. */
async function mountTab() {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dogsFn = vi.fn(async () => before());
  const unitsFn = vi.fn(async () => unitsData());
  const dogs = new QueryObserver(qc, { queryKey: ["client-dogs", CLIENT], queryFn: dogsFn });
  const units = new QueryObserver(qc, { queryKey: ["client-units", CLIENT], queryFn: unitsFn });
  stop = [dogs.subscribe(() => {}), units.subscribe(() => {})];
  await vi.waitFor(() => expect(qc.getQueryData(["client-dogs", CLIENT])).toBeTruthy());
  await vi.waitFor(() => expect(qc.getQueryData(["client-units", CLIENT])).toBeTruthy());
  return { dogsFn, unitsFn };
}

afterEach(() => {
  stop.forEach((s) => s());
  qc?.clear();
});

describe("moving a dog updates both unit lists (#601)", () => {
  it("the dog leaves the old unit and shows on the new one at once", async () => {
    await mountTab();
    expect(onUnit(qc, A)).toEqual(["pip", "rex"]);
    expect(onUnit(qc, B)).toEqual(["bo"]);

    await applyDogMove(qc, CLIENT, "pip", B);

    expect(onUnit(qc, A)).toEqual(["rex"]);
    expect(onUnit(qc, B)).toEqual(["bo", "pip"]);
  });

  it("a read from before the move does not put the dog back", async () => {
    const { dogsFn } = await mountTab();
    const callsBefore = dogsFn.mock.calls.length;

    await applyDogMove(qc, CLIENT, "pip", B);
    await new Promise((r) => setTimeout(r, 0));

    expect(dogsFn.mock.calls.length).toBe(callsBefore);
    expect(onUnit(qc, A)).toEqual(["rex"]);
    expect(onUnit(qc, B)).toEqual(["bo", "pip"]);
    // Stale, so the next mount or return to the app reads it again.
    expect(qc.getQueryState(["client-dogs", CLIENT])?.isInvalidated).toBe(true);
  });

  it("a read already in flight when the move lands is cancelled", async () => {
    await mountTab();
    let release!: () => void;
    const slow = new Promise<void>((r) => (release = r));
    const inFlight = qc
      .fetchQuery({
        queryKey: ["client-dogs", CLIENT],
        queryFn: async () => {
          await slow;
          return before();
        },
        staleTime: 0,
      })
      .catch(() => undefined);

    await applyDogMove(qc, CLIENT, "pip", B);
    release();
    await inFlight;

    expect(onUnit(qc, A)).toEqual(["rex"]);
    expect(onUnit(qc, B)).toEqual(["bo", "pip"]);
  });

  it("the Units query is refetched", async () => {
    const { unitsFn } = await mountTab();
    const callsBefore = unitsFn.mock.calls.length;
    await applyDogMove(qc, CLIENT, "pip", B);
    await vi.waitFor(() => expect(unitsFn.mock.calls.length).toBe(callsBefore + 1));
  });

  it("invalidating alone, as before the fix, leaves the dog on its old unit", async () => {
    await mountTab();
    // The server has moved Pip; the read answers from before the move.
    await qc.invalidateQueries({ queryKey: ["client-dogs", CLIENT] });
    expect(onUnit(qc, A)).toEqual(["pip", "rex"]);
    expect(onUnit(qc, B)).toEqual(["bo"]);
  });
});

describe("the Units tab Move uses it", () => {
  const src = readFileSync(
    join(import.meta.dirname, "..", "src/components/client-detail/UnitsTab.tsx"),
    "utf8",
  );
  const move = src.slice(
    src.indexOf("const moveMut = useMutation"),
    src.indexOf("const deleteMut"),
  );

  it("onSuccess applies the move to the cache", () => {
    expect(move).toMatch(/await applyDogMove\(qc, clientId, v\.id, v\.unitId\)/);
  });
});
