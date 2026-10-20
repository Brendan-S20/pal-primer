// A walk is asked for in a window (#410).
//
// The portal's booking card offers a dog walk a Time: the business's working
// day (organizations.workday_start / workday_end) in two-hour windows on the
// hour, "Any time" by default. The server accepts only a window it offered,
// for a walk, and refuses anything else in plain words. The window rides on
// the request (qc_tickets.requested_earliest_time / latest_time) so the office
// sees it, and the office's Book it carries it onto the booked visit's plan,
// where the planner keeps it. Auto-accept carries it the same way.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_WALK_DAY,
  WINDOW_NOT_OFFERED,
  clockLabel,
  isOfferedWindow,
  normalizeClock,
  walkWindows,
  windowLabel,
} from "@/lib/walk-windows";
import { checkedWalkWindow, recordRequestedWindow } from "@/lib/walk-request.server";
import { oneOffServiceOptions } from "@/lib/one-off-booking";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the windows on offer", () => {
  it("splits the working day into two-hour windows on the hour, cutting the last at the end", () => {
    expect(walkWindows("08:00:00", "17:00:00")).toEqual([
      { start: "08:00", end: "10:00" },
      { start: "10:00", end: "12:00" },
      { start: "12:00", end: "14:00" },
      { start: "14:00", end: "16:00" },
      { start: "16:00", end: "17:00" },
    ]);
  });

  it("starts on the next hour when the day starts on a half hour", () => {
    expect(walkWindows("07:30", "12:00").map((w) => w.start)).toEqual(["08:00", "10:00"]);
  });

  it("falls back to 08:00 to 18:00 when the hours are missing or make no day", () => {
    const fallback = walkWindows(DEFAULT_WALK_DAY.start, DEFAULT_WALK_DAY.end);
    expect(fallback).toHaveLength(5);
    expect(fallback[0]).toEqual({ start: "08:00", end: "10:00" });
    expect(fallback[4]).toEqual({ start: "16:00", end: "18:00" });
    expect(walkWindows(null, null)).toEqual(fallback);
    expect(walkWindows("nonsense", "17:00")).toEqual(fallback);
    expect(walkWindows("17:00", "08:00")).toEqual(fallback);
  });

  it("accepts exactly an offered window, or none, and never half of one", () => {
    const w = walkWindows("08:00", "17:00");
    expect(isOfferedWindow(w, undefined, undefined)).toBe(true);
    expect(isOfferedWindow(w, "10:00", "12:00")).toBe(true);
    expect(isOfferedWindow(w, "10:00:00", "12:00:00")).toBe(true);
    expect(isOfferedWindow(w, "10:00", "11:00")).toBe(false);
    expect(isOfferedWindow(w, "06:00", "08:00")).toBe(false);
    expect(isOfferedWindow(w, "10:00", undefined)).toBe(false);
    expect(isOfferedWindow(w, undefined, "12:00")).toBe(false);
  });

  it("says the window in words a client reads", () => {
    expect(clockLabel("08:00")).toBe("8 AM");
    expect(clockLabel("12:00:00")).toBe("12 PM");
    expect(clockLabel("13:30")).toBe("1:30 PM");
    expect(windowLabel("10:00", "12:00")).toBe("10 AM to 12 PM");
    expect(windowLabel(null, null)).toBeNull();
    expect(normalizeClock("9:05:00")).toBe("09:05");
    expect(normalizeClock("25:00")).toBeNull();
  });
});

/** Organizations answers the working day; every update is recorded. */
function fakeAdmin(day = { workday_start: "08:00:00", workday_end: "17:00:00" }) {
  const updates: Array<{ table: string; patch: unknown; eqs: unknown[][] }> = [];
  return {
    updates,
    from(table: string) {
      const eqs: unknown[][] = [];
      let patch: unknown = null;
      const q: any = {
        select: () => q,
        eq: (...a: unknown[]) => (eqs.push(a), q),
        update: (p: unknown) => ((patch = p), q),
        maybeSingle: async () => ({ data: table === "organizations" ? day : null, error: null }),
        then: (res: (v: unknown) => unknown) => {
          updates.push({ table, patch, eqs });
          return Promise.resolve({ error: null }).then(res);
        },
      };
      return q;
    },
  };
}

describe("the server's check", () => {
  const walkService = { service_line: "dog_walking" };

  it("is nothing when no window was picked", async () => {
    await expect(checkedWalkWindow(fakeAdmin(), "org", walkService, {})).resolves.toBeNull();
    await expect(checkedWalkWindow(fakeAdmin(), "org", null, {})).resolves.toBeNull();
  });

  it("returns the window and its words for an offered one", async () => {
    await expect(
      checkedWalkWindow(fakeAdmin(), "org", walkService, { earliestTime: "10:00", latestTime: "12:00" }),
    ).resolves.toEqual({ earliest: "10:00", latest: "12:00", label: "10 AM to 12 PM" });
  });

  it("refuses a window that was not offered, in plain words", async () => {
    await expect(
      checkedWalkWindow(fakeAdmin(), "org", walkService, { earliestTime: "05:00", latestTime: "07:00" }),
    ).rejects.toThrow(WINDOW_NOT_OFFERED);
    await expect(
      checkedWalkWindow(fakeAdmin(), "org", walkService, { earliestTime: "10:00" }),
    ).rejects.toThrow(WINDOW_NOT_OFFERED);
  });

  it("refuses a window on anything that is not a walk", async () => {
    for (const service of [null, { service_line: "pet_waste" }, { service_line: "pet_sitting" }]) {
      await expect(
        checkedWalkWindow(fakeAdmin(), "org", service, { earliestTime: "10:00", latestTime: "12:00" }),
      ).rejects.toThrow(/only be picked for a walk/);
    }
  });

  it("writes the window onto this organization's request only", async () => {
    const sb = fakeAdmin();
    await recordRequestedWindow(sb, "org-1", "ticket-1", {
      earliest: "10:00",
      latest: "12:00",
      label: "10 AM to 12 PM",
    });
    expect(sb.updates).toEqual([
      {
        table: "qc_tickets",
        patch: { requested_earliest_time: "10:00", requested_latest_time: "12:00" },
        eqs: [
          ["id", "ticket-1"],
          ["organization_id", "org-1"],
        ],
      },
    ]);
  });
});

describe("the wiring, end to end", () => {
  const fns = read("src/lib/portal.functions.ts");
  const request = fns.slice(fns.indexOf("export const portalRequestOneOff"));
  const options = fns.slice(
    fns.indexOf("export const portalOneOffBookingOptions"),
    fns.indexOf("export const portalRequestOneOff"),
  );

  it("the options offer the working day's windows", () => {
    expect(options).toMatch(/workday_start, workday_end/);
    expect(options).toMatch(/walkWindows: walkWindows\(org\?\.workday_start/);
  });

  it("the request checks the window before anything is saved, then records and books it", () => {
    expect(request).toMatch(/earliestTime: z\.string\(\)\.regex/);
    expect(request).toMatch(/latestTime: z\.string\(\)\.regex/);
    const check = request.indexOf("checkedWalkWindow(sb, session.organizationId, service, data)");
    const rpc = request.indexOf('rpc("portal_request_one_off"');
    expect(check).toBeGreaterThan(0);
    expect(check).toBeLessThan(rpc);
    expect(request).toMatch(
      /recordRequestedWindow\(sb, session\.organizationId, ticketId, walkWindow\)/,
    );
    expect(request).toMatch(/earliestTime: walkWindow\?\.earliest \?\? null/);
    expect(request).toMatch(/latestTime: walkWindow\?\.latest \?\? null/);
  });

  it("the services carry their line, so the card knows which one is a walk", () => {
    // Walking is Coming soon (#506), so the portal does not offer it yet;
    // this drives the path as it will run once the line is bookable.
    const [walk] = oneOffServiceOptions(
      [
        {
          id: "w",
          name: "Walk",
          service_line: "dog_walking",
          active: true,
          price_unit: "visit",
          base_price_cents: 2500,
          extra_pet_cents: 0,
          default_duration_min: 30,
        } as any,
      ],
      null,
      ["pet_waste", "dog_walking"],
    );
    expect(walk.serviceLine).toBe("dog_walking");
  });

  it("the card offers a Time only for a walk, Any time first, and the confirmation states it", () => {
    const card = read("src/components/portal/OneOffBookingCard.tsx");
    expect(card).toMatch(/chosen\?\.serviceLine === "dog_walking" \? \(opts\?\.walkWindows \?\? \[\]\) : \[\]/);
    expect(card).toMatch(/id="one-off-time"/);
    expect(card).toMatch(/<option value="">Any time<\/option>/);
    expect(card).toMatch(/earliestTime: picked\.start, latestTime: picked\.end/);
    expect(card).toMatch(/done\.window \? `, \$\{done\.window\}` : ""/);
  });

  it("the office sees the window and Book it carries it onto the visit", () => {
    expect(read("src/lib/concerns.functions.ts")).toMatch(
      /requested_earliest_time, requested_latest_time/,
    );
    const concerns = read("src/routes/_authenticated/concerns.tsx");
    expect(concerns).toMatch(/earliestTime: c\.requested_earliest_time \?\? null/);
    expect(concerns).toMatch(/windowLabel\(concern\.requested_earliest_time, concern\.requested_latest_time\)/);
    const dialog = read("src/components/BookOneOffRequestDialog.tsx");
    expect(dialog).toMatch(/earliestTime: t\.earliestTime, latestTime: t\.latestTime/);
    const visits = read("src/lib/visits.functions.ts");
    const create = visits.slice(visits.indexOf("export const createOneOffVisit"));
    expect(create.slice(0, 1500)).toMatch(/earliestTime: z\.string\(\)/);
    // bookOneOffVisit writes them onto the one-off's plan.
    const server = read("src/lib/one-off-visit.server.ts");
    expect(server).toMatch(/earliest_time: input\.earliestTime/);
    expect(server).toMatch(/latest_time: input\.latestTime/);
  });
});

describe("the migration", () => {
  const sql = read("supabase/migrations/20261015220000_a-client-hears-when-a-walk-changes.sql");

  it("adds the window to the request, both or neither, end after start", () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS requested_earliest_time time/);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS requested_latest_time time/);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS qc_tickets_requested_window_shape/);
    expect(sql).toMatch(/requested_latest_time > requested_earliest_time/);
  });

  it("ends by refusing a replay that did not establish it", () => {
    expect(sql).toMatch(/DO \$check\$[\s\S]*RAISE EXCEPTION[\s\S]*qc_tickets_requested_window_shape[\s\S]*\$check\$;\s*$/);
  });
});
