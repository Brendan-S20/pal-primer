// Booking a lesson already names a trainer clash (trainerConflicts). Moving or
// reassigning one did not: a portal request booked from Concerns has no
// trainer, and assigning it later on the board, the drawer or the client's
// Visits tab could put two lessons on one trainer at once with nobody told.
// The product reviews of #476 asked for the same check on those paths.
//
// The move still happens, as booking's "book anyway" lets it; the office
// functions return the clashes and the screens say so.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/authz.server", () => ({ requirePermission: vi.fn(), resolveCaller: vi.fn() }));
vi.mock("@/lib/manual-invoice.server", () => ({ insertManualInvoice: vi.fn() }));

import {
  lessonClashes,
  lessonClashesAfterMove,
  type TrainingDb,
} from "@/lib/training-packages.server";

const LESSON = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

type Row = Record<string, unknown>;

/** Answers the two reads lessonClashes makes: the moved visits by id, and
 *  the trainer's other stops that day. Records every filter. */
function fake(moved: Row[], trainerDay: Row[]) {
  const calls: Array<[string, ...unknown[]]> = [];
  const db = {
    from() {
      let byId = false;
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "not"])
        q[m] = (...args: unknown[]) => {
          calls.push([m, ...args]);
          if (m === "in" && args[0] === "id") byId = true;
          return q;
        };
      q.then = (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: byId ? moved : trainerDay, error: null }).then(res);
      return q;
    },
  };
  return { db: db as unknown as TrainingDb, calls };
}

const lesson = (over: Row = {}): Row => ({
  id: LESSON,
  organization_id: "org-a",
  scheduled_on: "2090-03-04",
  status: "scheduled",
  assigned_staff_id: "trainer-1",
  client_package_id: "pack-1",
  subscriptions: { earliest_time: "10:00:00", latest_time: "11:00:00" },
  services: { default_duration_min: 60 },
  ...over,
});

describe("a moved or reassigned lesson", () => {
  it("names the trainer's other stop it now overlaps, and not itself", async () => {
    const { db, calls } = fake(
      [lesson()],
      [
        // The lesson itself, now on the trainer's day.
        { id: LESSON, scheduled_on: "2090-03-04", subscriptions: lesson().subscriptions },
        {
          id: OTHER,
          scheduled_on: "2090-03-04",
          subscriptions: { earliest_time: "10:30:00", latest_time: null },
          services: { default_duration_min: 45 },
        },
      ],
    );
    await expect(lessonClashes(db, [LESSON])).resolves.toEqual([
      { visitId: LESSON, date: "2090-03-04", start: "10:30", end: "11:15" },
    ]);
    expect(calls).toContainEqual(["not", "client_package_id", "is", null]);
    expect(calls).toContainEqual(["eq", "assigned_staff_id", "trainer-1"]);
    expect(calls).toContainEqual(["eq", "organization_id", "org-a"]);
  });

  it("says nothing for a lesson with no trainer, no start time, or no longer scheduled", async () => {
    const busy = [{ id: OTHER, scheduled_on: "2090-03-04", subscriptions: lesson().subscriptions }];
    for (const over of [
      { assigned_staff_id: null },
      { subscriptions: { earliest_time: null, latest_time: null } },
      { status: "completed" },
    ]) {
      const { db } = fake([lesson(over)], busy);
      await expect(lessonClashes(db, [LESSON])).resolves.toEqual([]);
    }
  });

  it("never throws after the move: a failed check is no clash, not a failed move", async () => {
    const db = {
      from() {
        throw new Error("network");
      },
    } as unknown as TrainingDb;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(lessonClashesAfterMove(db, [LESSON])).resolves.toEqual([]);
    log.mockRestore();
  });

  it("is reported by every office path that moves or reassigns a visit, and shown", () => {
    const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");
    const server = read("src/lib/visits.functions.ts");
    for (const fn of [
      "reassignVisit",
      "rescheduleVisitFromOffice",
      "bulkAssignVisits",
      "bulkRescheduleVisits",
    ]) {
      const start = server.indexOf(`export const ${fn} =`);
      const next = server.indexOf("export const ", start + 1);
      expect(server.slice(start, next), fn).toMatch(/lessonClashesAfterMove\(/);
    }
    for (const screen of [
      "src/routes/_authenticated/routes.tsx",
      "src/components/VisitDetailDrawer.tsx",
      "src/components/client-detail/VisitsTab.tsx",
    ])
      expect(read(screen), screen).toMatch(/warnLessonClashes\(/);
  });
});
