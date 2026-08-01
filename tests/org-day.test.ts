import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_ORG_TIMEZONE,
  daysBetweenOrgDays,
  orgLocalDay,
  orgToday,
} from "@/lib/org-day";
import { isInvoiceOverdue, summarizeAr } from "@/lib/ar";

// Seven surfaces decided what day it was using the SERVER's clock. For an
// organization in America/Chicago, UTC is a day ahead from 19:00 local until
// midnight — five hours of every day, 21% of the clock — and everything keyed
// on a date is wrong inside it.
//
// Proven live before the fix, on an invoice issued 2026-08-01 02:00 UTC, which
// is 2026-07-31 21:00 in Chicago:
//
//   db_utc_day=2026-08-01  org_local_day=2026-07-31
//   due_on WRITTEN=2026-08-16  SHOULD BE=2026-08-15  drift=1
//
// After: 9pm CT → 2026-08-15, noon CT → 2026-08-16, explicit due_on preserved.
//
// Most of this file tests BEHAVIOUR rather than source text, because the
// behaviour is what was wrong. The two source scans at the end exist because a
// new call site can reintroduce the bug without touching anything tested here.

const ROOT = new URL("..", import.meta.url).pathname;

/** 2026-08-01 02:00Z — the instant the live probe used. 9pm on July 31st in
 *  Chicago, and already August in UTC. */
const EVENING = "2026-08-01T02:00:00Z";

describe("orgLocalDay", () => {
  it("gives the organization's calendar day, not the server's", () => {
    expect(orgLocalDay(EVENING, "America/Chicago")).toBe("2026-07-31");
    expect(new Date(EVENING).toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("formats as YYYY-MM-DD so it compares against date columns directly", () => {
    // due_on, scheduled_on and period_start are DATE columns. A different shape
    // would compare lexicographically wrong rather than failing loudly.
    expect(orgLocalDay(EVENING, "America/Chicago")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("handles a zone east of UTC, where the error runs the other way", () => {
    // 02:00 UTC is already mid-morning in Tokyo — same instant, later day.
    expect(orgLocalDay(EVENING, "Asia/Tokyo")).toBe("2026-08-01");
    expect(orgLocalDay("2026-07-31T20:00:00Z", "Asia/Tokyo")).toBe("2026-08-01");
    expect(orgLocalDay("2026-07-31T20:00:00Z", "America/Chicago")).toBe("2026-07-31");
  });

  it("returns '' for an unparseable input rather than 'Invalid Date'", () => {
    // Callers compare the result against date strings. "" sorts below every
    // real date; "Invalid Date" would sort above them and read as the future.
    expect(orgLocalDay("not a date", "America/Chicago")).toBe("");
    expect(orgLocalDay("")).toBe("");
  });

  it("defaults to the same zone the database defaults to", () => {
    // organizations.timezone defaults to America/Chicago and every migration
    // says coalesce(timezone, 'America/Chicago'). If this constant drifted from
    // that, the same invoice would get two different due dates depending on
    // which layer computed it.
    expect(DEFAULT_ORG_TIMEZONE).toBe("America/Chicago");
    expect(orgLocalDay(EVENING)).toBe(orgLocalDay(EVENING, "America/Chicago"));
  });
});

describe("orgToday", () => {
  it("reads the injected clock in the organization's zone", () => {
    expect(orgToday("America/Chicago", new Date(EVENING))).toBe("2026-07-31");
    expect(orgToday("UTC", new Date(EVENING))).toBe("2026-08-01");
  });
});

describe("daysBetweenOrgDays", () => {
  it("counts calendar days, not elapsed hours", () => {
    // An invoice issued at 23:00 yesterday is ONE day old on an accountant's
    // schedule. Subtracting timestamps and dividing by 86,400,000 says zero,
    // which is how /reports put it in the wrong aging bucket.
    expect(daysBetweenOrgDays("2026-07-31", "2026-08-01")).toBe(1);
    expect(daysBetweenOrgDays("2026-08-01", "2026-08-01")).toBe(0);
  });

  it("survives a DST boundary, where a day is 23 or 25 hours long", () => {
    // US DST ends 2026-11-01. Hour arithmetic would give 30.04 days here and
    // Math.floor it to 30, moving an invoice between the d30 and d60 buckets.
    expect(daysBetweenOrgDays("2026-10-15", "2026-11-14")).toBe(30);
    expect(daysBetweenOrgDays("2026-03-01", "2026-03-31")).toBe(30);
  });

  it("is 0 for a missing or unparseable day rather than NaN", () => {
    // NaN in a bucket comparison is false everywhere, which silently drops the
    // invoice out of the aging report entirely.
    expect(daysBetweenOrgDays("", "2026-08-01")).toBe(0);
    expect(daysBetweenOrgDays("2026-08-01", "nonsense")).toBe(0);
  });
});

describe("AR overdue at the boundary", () => {
  const invoice = { status: "open", total_cents: 10_000, due_on: "2026-07-31" };

  it("is not overdue on its due date in the organization's zone", () => {
    // The bug in one assertion: at 9pm Chicago on the 31st the server already
    // says 2026-08-01, so this invoice read as overdue five hours before it
    // was due — on the staff list, the drawer, and the customer's own portal.
    expect(isInvoiceOverdue(invoice, orgToday("America/Chicago", new Date(EVENING)))).toBe(false);
  });

  it("is overdue once the organization's day has actually moved on", () => {
    expect(isInvoiceOverdue(invoice, orgToday("America/Chicago", new Date("2026-08-01T14:00:00Z")))).toBe(
      true,
    );
  });

  it("summarizeAr agrees with isInvoiceOverdue at that boundary", () => {
    // The digest called summarizeAr with no `today` while the timezone sat in
    // scope, so the weekly email disagreed with the dashboard it summarised.
    const today = orgToday("America/Chicago", new Date(EVENING));
    expect(summarizeAr([invoice as never], today).overdueCount).toBe(0);
    expect(summarizeAr([invoice as never], "2026-08-01").overdueCount).toBe(1);
  });
});

// ── the two source scans ───────────────────────────────────────────────────

const LIB = join(ROOT, "src", "lib");

function libFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ts$/.test(e.name)) out.push(p);
    }
  };
  walk(LIB);
  return out;
}

describe("no money surface takes the day from the server again", () => {
  // Named files rather than a blanket rule. An idempotency key like
  // `winback-${id}-${todayUTC}` genuinely does not care which day it is — it
  // only has to be stable — and a rule broad enough to catch those gets
  // exceptions bolted on until it means nothing.
  const MUST_USE_ORG_DAY = [
    "src/lib/ar.ts",
    "src/lib/overdue.ts",
    "src/lib/dashboard.functions.ts",
    "src/lib/reports.functions.ts",
    "src/lib/analytics.functions.ts",
    "src/lib/accounting.server.ts",
  ];

  for (const rel of MUST_USE_ORG_DAY) {
    it(`${rel} derives its day from org-day`, () => {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const code = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
        .join("\n");
      expect(code, `${rel} does not import org-day`).toMatch(/from "@\/lib\/org-day"/);
      // The exact expression that was wrong, in code rather than commentary.
      expect(code, `${rel} still takes the UTC day`).not.toMatch(
        /new Date\(\)\.toISOString\(\)\.slice\(0,\s*10\)/,
      );
      expect(code, `${rel} still slices an ISO timestamp into a day`).not.toMatch(
        /issued_at\??\.slice\(0,\s*10\)/,
      );
    });
  }

  it("there is exactly one definition of the org's calendar day", () => {
    // There were two — orgLocalDay in cpa-reports.ts and orgLocalDate in
    // digest.server.ts, written months apart with identical bodies and
    // different names. That is how the third caller writes a fourth.
    const definitions = libFiles().filter((p) => {
      if (p.endsWith("org-day.ts")) return false;
      const src = readFileSync(p, "utf8");
      return /new Intl\.DateTimeFormat\(\s*["']en-CA["']/.test(src);
    });
    expect(definitions.map((p) => p.replace(ROOT, ""))).toEqual([]);
  });
});
