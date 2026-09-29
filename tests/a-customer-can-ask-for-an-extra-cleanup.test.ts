// A customer can ask for an extra cleanup -- on a day the business would say
// yes to.
//
// The database decides whether a request is accepted (portal_request_one_off);
// the portal decides which days to OFFER, with bookableDays in
// src/lib/one-off-booking.ts. If the two disagree the customer picks a day
// from the list and is told no, or never sees a day that would have been fine,
// and each half is right by itself. So the first block pins the TypeScript
// rule edge by edge, and the second reads the migration to make sure the SQL
// is still the rule being pinned. The function itself is exercised against a
// real database in a-double-tap-books-one-extra-cleanup.test.ts.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bookableDays,
  dayOfWeek,
  ONE_OFF_MAX_DAYS_AHEAD,
  oneOffRefusalMessage,
  oneOffRequestState,
} from "@/lib/one-off-booking";

// 2026-09-29 is a Tuesday.
const TODAY = "2026-09-29";
const WEEKDAYS = [1, 2, 3, 4, 5];

describe("the days the portal offers", () => {
  it("numbers days as Postgres extract(dow) does: 0 is Sunday", () => {
    expect(dayOfWeek("2026-09-27")).toBe(0);
    expect(dayOfWeek("2026-09-29")).toBe(2);
    expect(dayOfWeek("2026-10-03")).toBe(6);
  });

  it("starts at the org's tomorrow, never today", () => {
    const days = bookableDays(TODAY, null);
    expect(days[0]).toBe("2026-09-30");
    expect(days).not.toContain(TODAY);
  });

  it("ends at today + 30, inclusive, and not a day later", () => {
    const days = bookableDays(TODAY, null);
    expect(days).toHaveLength(ONE_OFF_MAX_DAYS_AHEAD);
    expect(days.at(-1)).toBe("2026-10-29");
    expect(days).not.toContain("2026-10-30");
  });

  it("offers only the org's working days", () => {
    const days = bookableDays(TODAY, WEEKDAYS);
    expect(days.every((d) => WEEKDAYS.includes(dayOfWeek(d)))).toBe(true);
    expect(days).not.toContain("2026-10-03"); // Saturday
    expect(days).not.toContain("2026-10-04"); // Sunday
    expect(days).toContain("2026-10-02"); // Friday
  });

  it("leaves out blackout days", () => {
    const days = bookableDays(TODAY, WEEKDAYS, ["2026-10-01"]);
    expect(days).not.toContain("2026-10-01");
    expect(days).toContain("2026-09-30");
  });

  it("treats a missing or empty work_days as every day, as the column default does", () => {
    expect(bookableDays(TODAY, [])).toEqual(bookableDays(TODAY, [0, 1, 2, 3, 4, 5, 6]));
  });

  it("crosses a month and a year without drifting", () => {
    const days = bookableDays("2026-12-20", null);
    expect(days[0]).toBe("2026-12-21");
    expect(days).toContain("2027-01-01");
    expect(days.at(-1)).toBe("2027-01-19");
  });
});

describe("what the customer is told", () => {
  it("turns every refusal code into a sentence, and passes anything else through", () => {
    for (const code of [
      "date_in_past",
      "date_too_soon",
      "date_too_far",
      "not_a_working_day",
      "blackout_day",
      "already_scheduled",
      "property_not_found",
      "invalid_token",
    ]) {
      const msg = oneOffRefusalMessage(code);
      expect(msg, code).not.toBe(code);
      expect(msg, code).not.toMatch(/_/);
    }
    expect(oneOffRefusalMessage("something unexpected")).toBe("something unexpected");
  });

  it("reads a request as booked, declined, or waiting", () => {
    expect(oneOffRequestState({ status: "resolved", booked_on: "2026-10-02" })).toBe("booked");
    expect(oneOffRequestState({ status: "resolved", booked_on: null })).toBe("declined");
    expect(oneOffRequestState({ status: "open", booked_on: null })).toBe("waiting");
    expect(oneOffRequestState({ status: "acknowledged" })).toBe("waiting");
  });
});

describe("the SQL is still the rule being pinned", () => {
  const sql = readFileSync(
    join(
      import.meta.dirname,
      "..",
      "supabase/migrations/20260929050000_the-schedule-lived-only-in-the-app.sql",
    ),
    "utf8",
  );
  const fn = sql.slice(
    sql.indexOf("CREATE OR REPLACE FUNCTION public.portal_request_one_off"),
    sql.indexOf("REVOKE ALL ON FUNCTION public.portal_request_one_off"),
  );

  it("measures today on the organization's clock", () => {
    expect(fn).toMatch(/_today\s*:=\s*\(now\(\)\s+AT\s+TIME\s+ZONE\s+_tz\)::date/);
  });

  it("refuses today and earlier, and more than 30 days out", () => {
    expect(fn).toMatch(/_on\s*<\s*_today\s+THEN\s+RAISE\s+EXCEPTION\s+'date_in_past'/);
    expect(fn).toMatch(/_on\s*=\s*_today\s+THEN\s+RAISE\s+EXCEPTION\s+'date_too_soon'/);
    expect(fn).toMatch(new RegExp(`_on\\s*>\\s*_today\\s*\\+\\s*${ONE_OFF_MAX_DAYS_AHEAD}\\s+THEN`));
  });

  it("reads work_days with extract(dow), and blackout_dates", () => {
    expect(fn).toMatch(/extract\(dow FROM _on\)::int = ANY/);
    expect(fn).toMatch(/blackout_dates/);
  });

  it("is granted exactly like portal_request_reclean: service_role only", () => {
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.portal_request_one_off\(uuid, uuid, date, text\) FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.portal_request_one_off\(uuid, uuid, date, text\) TO service_role;/,
    );
  });
});
