import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RECEIVED_PAYMENT_STATUSES,
  grossReceivedCents,
  paymentWasReceived,
  receivedPaymentStatuses,
} from "@/lib/revenue";

// IMP-10 / BUG-21.
//
// The parity half of this file follows the IMP-3 pattern: the rule exists in
// TypeScript and in SQL, and the two must not drift. Drift is exactly how BUG-21
// happened — the settlement routine and two TypeScript loops all computed
// "revenue" and only one of them was ever corrected.
//
// The failure this guards against is silent by construction. Nothing errors if
// SQL says `succeeded` and TypeScript says `succeeded, refunded`; the two just
// produce different money, on different screens, for the same period.

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

/** Every `status IN (...)` list a migration applies to public.payments. */
function paymentStatusListsIn(sql: string): string[][] {
  // Strip SQL comments first. The header of these migrations discusses the
  // statuses in prose, and a naive scan would parse the explanation as code —
  // the same trap the permission parity test fell into on an inline comment.
  const code = sql.replace(/--[^\n]*/g, "");
  const out: string[][] = [];
  const re = /status\s+IN\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    const statuses = m[1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
    if (statuses.length) out.push(statuses);
  }
  return out;
}

function latestDefinitionOf(fnName: string): string {
  // CREATE OR REPLACE means the LAST migration touching a function is the one
  // in force. Comparing against an earlier copy would let a regression pass.
  const files = readdirSync(MIGRATIONS)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  let found = "";
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), "utf8");
    if (new RegExp(`FUNCTION\\s+public\\.${fnName}\\s*\\(`, "i").test(sql)) found = sql;
  }
  return found;
}

describe("TS↔SQL parity on what counts as revenue", () => {
  it("finds the settlement routine at all", () => {
    // If this fails the rest is vacuous — a parity test that silently matches
    // nothing is worse than no test.
    expect(latestDefinitionOf("generate_franchise_settlements").length).toBeGreaterThan(0);
  });

  it("the settlement routine counts exactly the statuses TypeScript counts", () => {
    const sql = latestDefinitionOf("generate_franchise_settlements");
    const lists = paymentStatusListsIn(sql);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect([...list].sort()).toEqual([...RECEIVED_PAYMENT_STATUSES].sort());
    }
  });

  it("the franchise rollup counts the same statuses", () => {
    const sql = latestDefinitionOf("franchise_rollup");
    const lists = paymentStatusListsIn(sql);
    expect(lists.length).toBeGreaterThan(0);
    for (const list of lists) {
      expect([...list].sort()).toEqual([...RECEIVED_PAYMENT_STATUSES].sort());
    }
  });

  it("the parser would notice a drifted list rather than matching anything", () => {
    expect(paymentStatusListsIn("AND p.status IN ('succeeded')")).toEqual([["succeeded"]]);
    expect(paymentStatusListsIn("-- p.status IN ('succeeded')\nSELECT 1")).toEqual([]);
  });
});

describe("what counts as money that arrived", () => {
  it("counts a payment that later got refunded", () => {
    // The whole bug in one assertion. A refund flips the row to 'refunded'; if
    // that stopped counting, the ORIGINAL receipt would vanish from the period
    // it happened in — restating a month that may already be filed.
    expect(paymentWasReceived("refunded")).toBe(true);
  });

  it("counts a successful payment", () => {
    expect(paymentWasReceived("succeeded")).toBe(true);
  });

  it("does not count money that never arrived", () => {
    expect(paymentWasReceived("pending")).toBe(false);
    expect(paymentWasReceived("failed")).toBe(false);
    expect(paymentWasReceived(null)).toBe(false);
    expect(paymentWasReceived(undefined)).toBe(false);
  });

  it("sums only the rows that arrived, even when the query forgot to filter", () => {
    // One call site had no status filter at all and counted declined cards as
    // revenue, in a number an AI assistant then read out loud.
    const rows = [
      { amount_cents: 10_000, status: "succeeded" },
      { amount_cents: 5_000, status: "refunded" },
      { amount_cents: 99_999, status: "failed" },
      { amount_cents: 99_999, status: "pending" },
    ];
    expect(grossReceivedCents(rows)).toBe(15_000);
  });

  it("treats a missing amount as zero rather than NaN", () => {
    expect(grossReceivedCents([{ status: "succeeded" }])).toBe(0);
    expect(grossReceivedCents([{ amount_cents: null, status: "succeeded" }])).toBe(0);
  });

  it("sums nothing when there is nothing", () => {
    expect(grossReceivedCents([])).toBe(0);
  });

  it("hands query builders a plain mutable array", () => {
    const a = receivedPaymentStatuses();
    expect(a).toEqual(["succeeded", "refunded"]);
    a.pop();
    // Mutating the copy must not corrupt the canonical list for the next caller.
    expect(receivedPaymentStatuses()).toEqual(["succeeded", "refunded"]);
    expect(RECEIVED_PAYMENT_STATUSES).toEqual(["succeeded", "refunded"]);
  });
});
