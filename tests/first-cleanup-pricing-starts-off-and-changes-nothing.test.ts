// "Off: no first-cleanup charge — the default for existing businesses, so
// nothing changes until an owner opts in."
//
// Two halves to "nothing changes", and the second is the one that needed
// care. A business with no online signup, or whose zones price the first
// cleanup at $0, charged nothing before and must charge nothing after. But a
// business whose signup page is LIVE was already charging the zone's first
// cleanup (public_quote returned it; createSignupPaymentIntent charged it), so
// setting that business to 'off' would have been a change: its page would
// stop charging overnight. The migration sets those rows to 'flat', which
// charges exactly what they charged before. The SQL proof checks it on rows
// that exist BEFORE the migration runs, which is the only way to test it.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FIRST_CLEANUP_OFF, parseFirstCleanupPricing } from "@/lib/first-cleanup";
import { signupChargeFromQuote } from "@/lib/signup-charge";
import {
  FIRST_CLEANUP_MIGRATION,
  proofDatabaseReachable,
  runFirstCleanupProof,
} from "./helpers/first-cleanup-proof";

const codeOnly = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

describe("the migration's default", () => {
  it("adds the column defaulting to off, with the CHECK beside it", () => {
    const sql = codeOnly(readFileSync(FIRST_CLEANUP_MIGRATION, "utf8"));
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS first_cleanup_pricing jsonb NOT NULL DEFAULT '\{"mode":"off"\}'::jsonb/,
    );
    expect(sql).toMatch(/CHECK \(public\.first_cleanup_pricing_is_valid\(first_cleanup_pricing\)\)/);
  });

  it("moves to flat only a business whose live signup page already charged a first cleanup", () => {
    const sql = codeOnly(readFileSync(FIRST_CLEANUP_MIGRATION, "utf8"));
    const update = sql.slice(sql.indexOf("UPDATE public.organizations o"));
    const stmt = update.slice(0, update.indexOf(";"));
    expect(stmt).toMatch(/SET first_cleanup_pricing = '\{"mode":"flat"\}'::jsonb/);
    // All three conditions, or the backfill turns on a charge nobody was
    // making: a business with signup off never took a first-cleanup payment.
    expect(stmt).toMatch(/o\.public_signup_enabled = true/);
    expect(stmt).toMatch(/z\.initial_cleanup_cents > 0/);
    expect(stmt).toMatch(/o\.first_cleanup_pricing = '\{"mode":"off"\}'::jsonb/);
  });
});

describe("the app reads a missing or default config as off", () => {
  it("parses the column default, and an org row from before the column, as off", () => {
    expect(parseFirstCleanupPricing({ mode: "off" })).toEqual(FIRST_CLEANUP_OFF);
    expect(parseFirstCleanupPricing(undefined)).toEqual(FIRST_CLEANUP_OFF);
  });

  it("charges an off business's signup exactly the visit, and nothing for a first cleanup", () => {
    expect(
      signupChargeFromQuote({
        initial_cleanup_cents: 0,
        recurring_price_cents: 2500,
        first_cleanup_mode: "off",
      }),
    ).toEqual({ firstCleanupCents: 0, recurringCents: 2500, amountCents: 2500, firstCleanupLabel: null });
  });

  it("charges a flat business's signup the same total as before this change", () => {
    // Before: amount = initial_cleanup_cents + recurring_price_cents.
    const q = { initial_cleanup_cents: 7500, recurring_price_cents: 2500, first_cleanup_mode: "flat" };
    expect(signupChargeFromQuote(q).amountCents).toBe(q.initial_cleanup_cents + q.recurring_price_cents);
  });
});

describe.skipIf(!proofDatabaseReachable)("on a real database, against rows that predate it", () => {
  it("keeps a live signup page's first cleanup, and starts everyone else off", () => {
    const run = runFirstCleanupProof();
    expect(run.status, run.out).toBe(0);
    expect(run.out).toMatch(/ok: an existing live signup page charges the same first cleanup/);
    expect(run.out).toMatch(/ok: a business with no first-cleanup charge still has none/);
    expect(run.out).toMatch(/ok: a new business starts off, and the zone's default fee is not charged/);
    expect(run.out).toMatch(/ALL FIRST-CLEANUP PROOFS PASSED/);
  });
});
