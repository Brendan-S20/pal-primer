// A customer could not ask for a re-clean.
//
// The database decides whether a request is accepted: portal_request_reclean
// refuses a visit completed more than `reclean_window_hours` ago, or any visit
// when the window is 0. The portal decides whether to OFFER the button, with
// isInsideRecleanWindow in src/lib/reclean.ts. If those two disagree, the
// customer is shown a button the server refuses — or the offer disappears an
// hour early — and nobody finds out, because each half is right by itself.
//
// So the first block pins the TypeScript rule to the SQL one, edge by edge,
// and the second reads the migration to make sure the SQL is still the rule
// being pinned. The E2E spec (tests/e2e/a-customer-can-ask-for-a-re-clean
// .spec.ts) exercises the function itself against a real database.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addDaysToDay,
  defaultRecleanDay,
  isInsideRecleanWindow,
  recleanDeadlineLabel,
  recleanRefusalMessage,
  recleanVisitNote,
  recleanWindowClosesAt,
} from "@/lib/reclean";
import { concernStatusFromDb, concernStatusToDb } from "@/lib/concerns.functions";

const H = 3_600_000;
const NOW = new Date("2026-09-28T18:00:00Z");
const ago = (hours: number) => new Date(NOW.getTime() - hours * H).toISOString();

describe("the window the portal offers is the window the database accepts", () => {
  it("offers a visit completed inside the window", () => {
    expect(isInsideRecleanWindow({ status: "completed", completed_at: ago(2) }, 48, NOW)).toBe(
      true,
    );
    expect(isInsideRecleanWindow({ status: "completed", completed_at: ago(47.9) }, 48, NOW)).toBe(
      true,
    );
  });

  it("offers it up to and including the last instant, like `completed_at >= now() - window`", () => {
    // SQL refuses `completed_at < now() - interval`, so exactly on the edge is
    // still inside.
    expect(isInsideRecleanWindow({ status: "completed", completed_at: ago(48) }, 48, NOW)).toBe(
      true,
    );
  });

  it("stops offering once the window has passed", () => {
    expect(isInsideRecleanWindow({ status: "completed", completed_at: ago(48.001) }, 48, NOW)).toBe(
      false,
    );
    expect(isInsideRecleanWindow({ status: "completed", completed_at: ago(200) }, 168, NOW)).toBe(
      false,
    );
  });

  it("offers nothing when the owner set the window to 0", () => {
    expect(isInsideRecleanWindow({ status: "completed", completed_at: ago(0.1) }, 0, NOW)).toBe(
      false,
    );
    expect(isInsideRecleanWindow({ status: "completed", completed_at: ago(0.1) }, null, NOW)).toBe(
      false,
    );
  });

  it("offers nothing for a visit that was not completed, or has no completion time", () => {
    expect(isInsideRecleanWindow({ status: "skipped", completed_at: ago(1) }, 48, NOW)).toBe(false);
    expect(isInsideRecleanWindow({ status: "completed", completed_at: null }, 48, NOW)).toBe(false);
    expect(
      isInsideRecleanWindow({ status: "completed", completed_at: "not a date" }, 48, NOW),
    ).toBe(false);
  });

  it("measures from when the visit was finished, which is an instant and needs no zone", () => {
    const closes = recleanWindowClosesAt("2026-09-28T23:00:00Z", 24);
    expect(closes?.toISOString()).toBe("2026-09-29T23:00:00.000Z");
    expect(recleanWindowClosesAt("2026-09-28T23:00:00Z", 0)).toBeNull();
  });
});

describe("what the customer and the office are shown, on the ORG's clock", () => {
  it("prints the deadline in the organization's timezone, not the device's", () => {
    // Completed 22:00 UTC Monday, 48 hours: closes 22:00 UTC Wednesday, which
    // is 5:00 PM in Chicago and 3:00 PM in Los Angeles.
    const done = "2026-09-28T22:00:00Z";
    expect(recleanDeadlineLabel(done, 48, "America/Chicago")).toMatch(/Wed.*5:00/);
    expect(recleanDeadlineLabel(done, 48, "America/Los_Angeles")).toMatch(/Wed.*3:00/);
    expect(recleanDeadlineLabel(done, 0, "America/Chicago")).toBe("");
  });

  it("opens the booking dialog on the org's tomorrow, which is not the UTC tomorrow after dinner", () => {
    // 8 PM Monday in Chicago is already Tuesday in UTC. The office in Chicago
    // means Tuesday by "tomorrow"; a UTC tomorrow would say Wednesday.
    const mondayEveningChicago = new Date("2026-09-29T01:00:00Z");
    expect(defaultRecleanDay("America/Chicago", mondayEveningChicago)).toBe("2026-09-29");
    expect(defaultRecleanDay("UTC", mondayEveningChicago)).toBe("2026-09-30");
  });

  it("adds days to a calendar day across a month end without a device zone", () => {
    expect(addDaysToDay("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDaysToDay("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDay("garbage", 1)).toBe("");
  });

  it("names the original visit on the free one", () => {
    expect(recleanVisitNote("Mon, Sep 28")).toBe("Re-clean for the visit on Mon, Sep 28");
    expect(recleanVisitNote("")).toBe("Re-clean for a recent visit");
  });

  it("turns the RPC's exception codes into sentences a customer can read", () => {
    expect(recleanRefusalMessage("reclean_window_closed")).toMatch(/window .* has closed/);
    expect(recleanRefusalMessage("reclean_off")).toMatch(/aren't available/);
    expect(recleanRefusalMessage("visit_not_completed")).toMatch(/hasn't been completed/);
    expect(recleanRefusalMessage("visit_is_a_reclean")).toMatch(/already a re-clean/);
    expect(recleanRefusalMessage("something else")).toBe("something else");
  });
});

describe("the inbox's 'In progress' is the table's 'acknowledged'", () => {
  // qc_tickets_status_check allows open / acknowledged / resolved and nothing
  // else. The inbox wrote 'in_progress', which the CHECK refused.
  it("writes a value the CHECK accepts", () => {
    const allowed = ["open", "acknowledged", "resolved"];
    for (const s of ["open", "in_progress", "resolved"] as const) {
      expect(allowed).toContain(concernStatusToDb(s));
    }
  });

  it("reads every stored value back as one of the inbox's three", () => {
    expect(concernStatusFromDb("acknowledged")).toBe("in_progress");
    expect(concernStatusFromDb("open")).toBe("open");
    expect(concernStatusFromDb("resolved")).toBe("resolved");
  });
});

describe("the migration still states the rule this file pins", () => {
  const sql = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "supabase/migrations/20260928110000_a-customer-could-not-ask-for-a-re-clean.sql",
    ),
    "utf8",
  );
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.portal_request_reclean"));

  it("refuses strictly before the window, so the edge is inside on both sides", () => {
    expect(fn).toMatch(/_completed_at < now\(\) - make_interval\(hours => _window\)/);
  });

  it("refuses a window of 0 and a visit with no completion time", () => {
    expect(fn).toMatch(/COALESCE\(_window, 0\) = 0/);
    expect(fn).toMatch(/_completed_at IS NULL/);
  });

  it("is granted to service_role only, like portal_report_concern", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.portal_request_reclean\(uuid, uuid, text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.portal_request_reclean\(uuid, uuid, text\) TO service_role;/,
    );
  });
});
