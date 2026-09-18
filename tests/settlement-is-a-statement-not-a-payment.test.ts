// A settlement statement is a record. HoundStack does not move the money.
//
// ── WHY THIS NEEDED SAYING AT ALL ─────────────────────────────────────────
//
// Owner decisions, 2026-08-16, on how royalty actually gets collected:
//
//   franchise collects   net the royalty out of what it remits
//   location collects    statement only, settle offline
//
// Both were already true of the code, which is the interesting part. The
// balance formula in generate_franchise_settlements is
//
//     balance = by_parent − royalty − loc_owes + fran_owes
//
// and `by_parent` is revenue the FRANCHISE collected, so the royalty is
// already deducted before the statement is written: $1,000 collected at 10%
// produces direction 'franchise_owes_location' and a net of $900, not an
// invoice for the location to pay. Nothing needed building for that.
//
// What was missing was the product SAYING which of those two worlds you are
// in. `setRoyaltyInvoiceStatus` flips a text field, and the controls read
// "Issue to location" then "Mark paid" — the exact shape of a billing flow.
// Everywhere else in this product a flow shaped like that DOES take the money:
// customer invoices, autopay, add-on subscriptions. A franchise owner has no
// reason to assume this one is different, and the cost of assuming wrongly is
// that nobody sends anything and both sides believe it is handled.
//
// ── WHAT THIS PINS, AND WHAT IT DELIBERATELY DOES NOT ─────────────────────
//
// It pins that the disclosure exists and reaches BOTH audiences. It does not
// pin the wording, beyond the one claim that carries the meaning — a test that
// asserts a whole sentence fails on every copy edit and teaches people to
// paste the string in rather than read it.
//
// It also does NOT assert that no payment code exists. Proving a negative
// across the codebase is the kind of check that passes because it was pointed
// at the wrong place. The honest statement is narrower: the screen tells the
// truth about what the button does.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("the settlement screen says who moves the money", () => {
  const src = read("src/components/FranchiseSettlementStatements.tsx");

  it("tells both sides that HoundStack does not move it", () => {
    // Both audiences, because the sentence is about what each side should DO
    // and they do different things — one pays or collects, the other watches
    // for it. A disclosure only the franchise sees leaves the location still
    // waiting for a transfer that is never coming.
    const notMove = [...src.matchAll(/does not move the money/g)];
    expect(notMove.length, "the disclosure is missing for one of the audiences").toBe(2);
  });

  it("keeps it next to the controls it is about", () => {
    // In the card header, above the rows carrying "Issue to location" and
    // "Mark paid". A note somewhere else on the page is a note nobody reads
    // before pressing the button it is warning about.
    const header = src.slice(src.indexOf("<CardHeader"), src.indexOf("<CardContent"));
    expect(header).toMatch(/does not move the money/);
  });

  it("still offers Mark paid, because the record is the point", () => {
    // The decision was "statement only", not "no status". Marking paid is how
    // both sides end up with the same record of a payment made elsewhere.
    expect(src).toMatch(/Mark paid/);
    expect(src).toMatch(/mark the statement paid here so both sides have the same record/);
  });
});

describe("the royalty is netted out, not invoiced, when the franchise collects", () => {
  // The first owner decision, pinned against the generator that implements it
  // rather than against prose. If someone later changes the balance formula to
  // bill the royalty separately, this is the test that notices.
  const sql = read(
    "supabase/migrations/20260801080000_four-ways-a-settlement-statement-was-wrong.sql",
  );

  it("subtracts the royalty from what the parent collected", () => {
    // by_parent − royalty − loc_owes + fran_owes. The first two terms are the
    // netting: revenue the franchise is already holding, less its cut.
    expect(sql).toMatch(/r\.by_parent\s*\n?\s*-\s*round\(r\.total \* r\.pct \/ 100\.0\)/);
  });

  it("and settles in whichever direction the balance runs", () => {
    // Netting only works if a negative balance can mean the FRANCHISE owes the
    // location. A one-directional statement would quietly drop that case.
    expect(sql).toMatch(/'franchise_owes_location'/);
    expect(sql).toMatch(/'location_owes_franchise'/);
    expect(sql).toMatch(/'settled'/);
  });
});
