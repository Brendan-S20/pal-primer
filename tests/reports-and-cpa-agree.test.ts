import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { arPositionAsOf, billedDay, billedInPeriod, outstandingAsOf } from "@/lib/ar";

// /reports and the CPA pack answered the same two questions differently, and an
// owner hands one to their accountant and reads the other over coffee.
//
//   July revenue     page $3,200.00   pack $3,185.00
//   July outstanding page $2,655.00   pack $2,550.00
//
// The $15.00 was one invoice settled ENTIRELY from account credit. It is
// 'paid', so the page counted it as revenue — but no money arrived and nothing
// in the bank matched it. The same expression never subtracted
// credit_applied_cents, and then subtracted refunds (a CASH contra) from an
// issue-dated ACCRUAL base, producing a figure on no basis at all.
//
// The $105.00 was three invoices issued on 1 August: the page never bounded
// receivables by the period, so a "July" position included August billing.
//
// Verified against live data after the fix — the shared rule as at 2026-07-31
// gives 255000, which is the pack's figure, where the page's old rule gave
// 265500.
//
// These tests were missing when the change landed. They are the point: a money
// figure with no test is a money figure nobody will notice going wrong.

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const TZ = "America/Chicago";

/** Minimal invoice rows. `as never` because the shared types carry more columns
 *  than any single assertion needs. */
const inv = (o: Record<string, unknown>) =>
  ({
    id: "i",
    client_id: "c",
    status: "open",
    total_cents: 0,
    credit_applied_cents: 0,
    due_on: null,
    issued_at: null,
    paid_at: null,
    voided_at: null,
    updated_at: null,
    ...o,
  }) as never;

describe("an invoice settled entirely from credit", () => {
  const creditSettled = inv({
    status: "paid",
    total_cents: 1500,
    credit_applied_cents: 1500,
    issued_at: "2026-07-10T15:00:00Z",
    paid_at: "2026-07-10T15:00:00Z",
  });

  it("is billed revenue — the work was invoiced", () => {
    const b = billedInPeriod([creditSettled], "2026-07-01", "2026-07-31", TZ);
    expect(b.billedCents).toBe(1500);
    expect(b.creditsAppliedCents).toBe(1500);
    // Net of the credit it is worth nothing, which is the whole $15.00.
    expect(b.netBilledCents).toBe(0);
  });

  it("is not a receivable, because it was settled", () => {
    expect(outstandingAsOf(creditSettled, "2026-07-31", TZ)).toBe(0);
  });

  it("was a receivable before it was settled", () => {
    // Point-in-time: on the 9th it was still owed.
    expect(outstandingAsOf(creditSettled, "2026-07-09", TZ)).toBe(0);
  });
});

describe("receivables are a position, not a status", () => {
  const paidInAugust = inv({
    status: "paid",
    total_cents: 10_000,
    issued_at: "2026-07-05T15:00:00Z",
    paid_at: "2026-08-04T15:00:00Z",
  });

  it("an invoice paid later was still open at the earlier date", () => {
    // The bug in one line: reading the CURRENT status answers "today", and this
    // page is asked about closed periods.
    expect(outstandingAsOf(paidInAugust, "2026-07-31", TZ)).toBe(10_000);
    expect(outstandingAsOf(paidInAugust, "2026-08-31", TZ)).toBe(0);
  });

  it("an invoice issued after the date is not in the position", () => {
    // The $105.00: three invoices issued 1 August, counted in a July figure.
    const august = inv({ total_cents: 3_500, issued_at: "2026-08-01T15:00:00Z" });
    expect(outstandingAsOf(august, "2026-07-31", TZ)).toBe(0);
    expect(outstandingAsOf(august, "2026-08-01", TZ)).toBe(3_500);
  });

  it("a void drops out from the day it was voided, not before", () => {
    const voided = inv({
      status: "void",
      total_cents: 5_000,
      issued_at: "2026-07-05T15:00:00Z",
      voided_at: "2026-07-20T15:00:00Z",
    });
    expect(outstandingAsOf(voided, "2026-07-19", TZ)).toBe(5_000);
    expect(outstandingAsOf(voided, "2026-07-31", TZ)).toBe(0);
  });

  it("a write-off drops out from the day it was written off", () => {
    const writtenOff = inv({
      status: "uncollectible",
      total_cents: 7_000,
      issued_at: "2026-07-05T15:00:00Z",
      updated_at: "2026-07-25T15:00:00Z",
    });
    expect(outstandingAsOf(writtenOff, "2026-07-24", TZ)).toBe(7_000);
    expect(outstandingAsOf(writtenOff, "2026-07-31", TZ)).toBe(0);
  });

  it("nets off credit already applied", () => {
    const partial = inv({
      total_cents: 29_500,
      credit_applied_cents: 2_000,
      issued_at: "2026-07-05T15:00:00Z",
    });
    expect(outstandingAsOf(partial, "2026-07-31", TZ)).toBe(27_500);
  });
});

describe("the two surfaces cannot disagree on the total", () => {
  const ledger = [
    inv({ total_cents: 10_000, issued_at: "2026-07-05T15:00:00Z" }),
    inv({ total_cents: 20_000, credit_applied_cents: 5_000, issued_at: "2026-06-01T15:00:00Z" }),
    inv({
      status: "paid",
      total_cents: 9_000,
      issued_at: "2026-07-02T15:00:00Z",
      paid_at: "2026-07-03T15:00:00Z",
    }),
    inv({ total_cents: 3_500, issued_at: "2026-08-01T15:00:00Z" }),
    // Issued ON the as-of day, so the `current` bucket is non-empty. Without
    // one, `aging.current` is 0 anyway and the bucket-sum assertion below
    // cannot tell a working implementation from one that drops `current` on
    // the floor — a mutation that did exactly that passed the first version.
    inv({ total_cents: 6_000, issued_at: "2026-07-31T15:00:00Z" }),
  ];

  it("the page's total is the sum of the pack's per-invoice rule", () => {
    // This is the guarantee, and it holds by construction only because both
    // call outstandingAsOf. If /reports ever grows its own arithmetic again,
    // this is what fails.
    const position = arPositionAsOf(ledger, "2026-07-31", TZ);
    const packTotal = ledger.reduce((n, i) => n + outstandingAsOf(i, "2026-07-31", TZ), 0);
    expect(position.outstandingCents).toBe(packTotal);
    expect(position.outstandingCents).toBe(31_000);
    expect(position.openCount).toBe(3);
  });

  it("the aging buckets sum to the same total they split", () => {
    // Non-empty in more than one bucket, or the sum proves nothing.
    // The SPLIT may differ between the two surfaces — the pack ages from the
    // due date, the page from the issue date, and that divergence is
    // deliberate and documented. The TOTAL may not.
    const { outstandingCents, aging } = arPositionAsOf(ledger, "2026-07-31", TZ);
    expect(aging.current, "the fixture must exercise the current bucket").toBeGreaterThan(0);
    expect(aging.d30 + aging.d60 + aging.d90, "and at least one aged bucket").toBeGreaterThan(0);
    expect(aging.current + aging.d30 + aging.d60 + aging.d90).toBe(outstandingCents);
  });

  it("dates every figure in the organization's calendar", () => {
    // 2026-08-01 02:00Z is 9pm on 31 July in Chicago. Getting this wrong moves
    // an invoice between two reporting periods.
    const evening = inv({ total_cents: 4_200, issued_at: "2026-08-01T02:00:00Z" });
    expect(outstandingAsOf(evening, "2026-07-31", TZ)).toBe(4_200);
    expect(outstandingAsOf(evening, "2026-07-31", "UTC")).toBe(0);
  });
});

describe("billedDay", () => {
  it("excludes what was never billed to anyone", () => {
    expect(billedDay(inv({ status: "void", issued_at: "2026-07-05T15:00:00Z" }), TZ)).toBeNull();
    expect(billedDay(inv({ status: "draft", issued_at: "2026-07-05T15:00:00Z" }), TZ)).toBeNull();
    expect(billedDay(inv({ status: "open", issued_at: null }), TZ)).toBeNull();
  });

  it("dates the rest by when they were issued", () => {
    expect(billedDay(inv({ status: "paid", issued_at: "2026-07-05T15:00:00Z" }), TZ)).toBe(
      "2026-07-05",
    );
  });
});

describe("no surface keeps its own copy of this arithmetic", () => {
  it("/reports imports the shared AR module and does no dating of its own", () => {
    const src = read("src/lib/reports.functions.ts");
    expect(src).toMatch(/from "@\/lib\/ar"/);
    // The three expressions that made this page disagree with the pack.
    const code = src
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    expect(code, "still slices an ISO timestamp into a day").not.toMatch(
      /issued_at\??\.slice\(0,\s*10\)/,
    );
    expect(code, "still ages by dividing elapsed milliseconds").not.toMatch(/86400000|86_400_000/);
    expect(code, "still filters receivables by current status").not.toMatch(/isOutstanding\(/);
  });

  it("the CPA pack imports the same functions rather than redeclaring them", () => {
    const src = read("src/lib/cpa-reports.functions.ts");
    expect(src).toMatch(/import \{[^}]*outstandingAsOf[^}]*\} from "@\/lib\/ar"/);
    expect(src, "the pack has its own outstandingAsOf again").not.toMatch(
      /function outstandingAsOf\(/,
    );
  });
});
