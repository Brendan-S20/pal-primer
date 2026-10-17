import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const SRC = readFileSync("src/lib/platform-addons.functions.ts", "utf8");

/** `subscribePlatformAddon` alone — bounded at the next export so this does not
 *  drift into the cancel path, which has the opposite job. */
function subscribeBody(): string {
  const start = SRC.indexOf("export const subscribePlatformAddon");
  const end = SRC.indexOf("export const cancelPlatformAddon");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

// ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
//
// Buying an add-on does two things that must both happen or neither: it creates
// a charge at Stripe, and it records the purchase in org_platform_addons. The
// function already knew that — it rolls the Stripe side back when the record
// fails, and says so in a comment ("Never bill without a record").
//
// It only rolled back ONE of the two shapes. A recurring add-on becomes a
// SUBSCRIPTION ITEM and was undone; a one-time add-on becomes an INVOICE ITEM,
// whose id was never captured, so the rollback was skipped and the user was
// told "You have not been charged" — with a $499 line already sitting on their
// next invoice. Done-for-you setup is the single most expensive thing in the
// catalog and the only one that takes that branch.
//
// Nothing caught it: this function had no behavioural test at all, and the two
// suites that mention platform-addons cover the deactivate helper and the
// price-resolution allowlist, neither of which reaches here.
//
// These are structural assertions rather than a simulated purchase. They cannot
// prove the rollback works, and they are not a substitute for exercising this
// against the Stripe sandbox. What they do is make the specific regression
// impossible to reintroduce silently: a new way to charge, with no matching way
// to undo, fails here.
describe("every way this function can charge has a way to undo", () => {
  it("captures the id of the one-time invoice item", () => {
    // Without the id there is nothing to delete, which is exactly how the
    // rollback came to be skipped.
    expect(subscribeBody()).toMatch(/invoiceItemId\s*=\s*invoiceItem\.id/);
  });

  it("deletes the invoice item when the record write fails", () => {
    const body = subscribeBody();
    const rollback = body.slice(body.indexOf("if (recordErr)"));
    expect(rollback).toMatch(/invoiceItems\.del\(/);
    expect(rollback).toMatch(/subscriptionItems\.del\(/);
  });

  it("only claims the customer was not charged when the undo actually worked", () => {
    // The old message was unconditional. An undo that throws leaves a real
    // charge in place, and telling someone they were not billed sends them
    // away from an invoice they are about to receive.
    const body = subscribeBody();
    const rollback = body.slice(body.indexOf("if (recordErr)"));
    expect(rollback).toMatch(/You have not been charged/);
    expect(rollback).toMatch(/could not be canceled automatically/);
  });

  it("has no charge-creating call that the rollback does not name", () => {
    // The general form of the bug: a third way to bill gets added later and
    // the undo is not extended with it. Every `<thing>.create(` that bills is
    // matched against a `<thing>.del(` in the failure branch.
    const body = subscribeBody();
    const rollback = body.slice(body.indexOf("if (recordErr)"));
    const BILLING_CREATES = /stripe\.(invoiceItems|subscriptionItems)\.create\(/g;
    const billed = new Set([...body.matchAll(BILLING_CREATES)].map((m) => m[1]));
    // Sanity: if this set is empty the regex has drifted and the test is
    // asserting nothing, which is the failure mode this repo keeps finding.
    expect(billed.size).toBeGreaterThan(0);
    const unmatched = [...billed].filter((kind) => !rollback.includes(`${kind}.del(`));
    expect(unmatched, "a way to charge with no way to undo it").toEqual([]);
  });
});
