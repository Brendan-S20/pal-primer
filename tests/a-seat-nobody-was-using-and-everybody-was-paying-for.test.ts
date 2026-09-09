import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Activating or deactivating an employee changes the billable seat count, and
// the Stripe seat-overage quantity is reconciled to match. That reconcile is
// best-effort ON PURPOSE and stays that way: a Stripe outage must never stop
// somebody deactivating an employee, and the staff row is written by the RPC
// before any of this runs, so it is correct either way.
//
// What was wrong is that a failure was invisible. `syncOrgSeatQuantity` already
// returns a discriminated result and all three call sites threw it away.
//
// That matters more here than a discarded result usually would, because
// NOTHING RECONCILES SEATS ON A SCHEDULE. Not the nightly run, not a cron. The
// only healing is the next staff toggle, the next invite accepted, or somebody
// opening the billing page, so a lost sync sits until one of those happens.
//
// And the two directions are not equally bad. Adding an employee and losing
// the sync undercharges us, which is our problem. Deactivating one and losing
// it means we go on charging the customer for a seat they no longer have.

const USERS_FN = readFileSync(join(process.cwd(), "src/lib/users.functions.ts"), "utf8");
const PAGE = readFileSync(
  join(process.cwd(), "src/routes/_authenticated/settings.users.tsx"),
  "utf8",
);
const SYNC = readFileSync(join(process.cwd(), "src/lib/seat-sync.server.ts"), "utf8");
const code = USERS_FN.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

describe("the reconcile reports what it did", () => {
  it("distinguishes skipped from failed", () => {
    // `skipped` is the ordinary answer for an org with no live subscription,
    // one not on a per-employee plan, or an unconfigured Stripe key. Reporting
    // those as failures would warn nearly every workspace, which is the mirror
    // of the fault being fixed.
    expect(code).toMatch(/state: "synced"/);
    expect(code).toMatch(/state: "skipped"/);
    expect(code).toMatch(/state: "failed"/);
  });

  it("reads the result rather than discarding it", () => {
    expect(code).not.toMatch(/^\s*await syncOrgSeatQuantity\(orgId\);\s*$/m);
    const calls = code.match(/const r = await syncOrgSeatQuantity\(orgId\)/g) ?? [];
    expect(calls.length, "a call site went back to discarding the result").toBeGreaterThanOrEqual(2);
  });

  it("returns it from both server functions", () => {
    expect(code).toMatch(/return \{ ok: true, seats \}/);
    const returns = code.match(/return \{ ok: true, seats \}/g) ?? [];
    expect(returns.length).toBe(2);
  });

  it("still does not block the staff toggle", () => {
    // The mutation this guards: "fixing" the silence by throwing, which would
    // put a Stripe outage between an owner and deactivating an employee.
    const block = code.slice(code.indexOf("let seats: SeatOutcome"), code.indexOf("return { ok: true, seats }"));
    expect(block).not.toMatch(/\bthrow\b/);
  });

  it("leaves the sync module's own contract alone", () => {
    // It was already right. The result type existed; only the callers were
    // wrong, and widening the module would have been the wrong repair.
    expect(SYNC).toMatch(/export type SeatSyncResult/);
    expect(SYNC).toMatch(/\{ skipped: string \}/);
  });
});

describe("and the person who just changed the team is told", () => {
  it("warns on failure", () => {
    expect(PAGE).toMatch(/r\?\.seats\?\.state === "failed"/);
    expect(PAGE).toMatch(/billing seat count was not updated/i);
  });

  it("stays quiet when the reconcile was skipped", () => {
    // No subscription, not a per-employee plan, no Stripe key. Ordinary.
    const i = PAGE.indexOf('r?.seats?.state === "failed"');
    const cond = PAGE.slice(i, PAGE.indexOf(")", PAGE.indexOf("{", i)));
    expect(cond).not.toMatch(/"skipped"/);
  });

  it("says what it costs them, not what failed internally", () => {
    // "Seat sync failed" is a sentence for us. What they can act on is that
    // the invoice may not match the team, and that opening Billing fixes it.
    expect(PAGE).toMatch(/next invoice may not match your team/i);
    expect(PAGE).toMatch(/Open Billing/);
  });

  it("holds it longer than the success toast beside it", () => {
    const i = PAGE.indexOf("billing seat count was not updated");
    expect(PAGE.slice(i, i + 260)).toMatch(/duration: 12000/);
  });
});
