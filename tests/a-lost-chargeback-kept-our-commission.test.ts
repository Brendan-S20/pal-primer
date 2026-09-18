// A refund gave our 50 bps back. A lost chargeback did not.
//
// `charge.refunded` in the Stripe webhook retrieves the charge's application
// fee and refunds our share of it, with a comment explaining that the fee is
// the platform's and must not be scoped with `{ stripeAccount }`. The dispute
// branch immediately below it — the same handler, the same `if/else` — set
// `kind`, `movesMoney`, `amount` and `disputeRef`, filed the review item, took
// the franchise adjustment, and never touched the fee.
//
// So on a lost chargeback the bank took the entire charge back off the tenant,
// charged them a dispute fee on top, and HoundStack kept its commission on the
// money they no longer had. That is worse than the refund case rather than
// better: on a refund the tenant at least chose to give the money back.
//
// ── WHY THE FIX IS SHAPED LIKE THE REFUND PATH AND NOT LIKE A REVERSAL ────
//
// The obvious implementation — "on a lost dispute, refund the fee" — has to
// answer a question about somebody else's system: does Stripe already reverse
// the application fee itself when a dispute is lost? Get that wrong in one
// direction and the fee is never returned; get it wrong in the other and the
// call errors because the fee is already fully refunded.
//
// The refund path had already solved this and the fix copies it verbatim. It
// computes a cumulative TARGET from the fee, subtracts what Stripe reports as
// already refunded of that fee, and sends only the difference. If Stripe
// reverses automatically, `amount_refunded` already equals the target, the
// delta is zero and nothing is sent. If it does not, the delta is the whole
// fee. Both worlds are correct without the code having to know which one it is
// in — and a replayed webhook, which Stripe will send, is a no-op in each.
//
// ── THE TWO THINGS THAT WOULD MAKE IT WRONG ──────────────────────────────
//
// Reversing on the wrong events. `charge.dispute.created` and `.closed` carry
// INQUIRIES as well as real chargebacks, and `planDisputeEvent` exists because
// this handler once read every `created` as a withdrawal. An inquiry that is
// simply dropped moves no money, so refunding a fee against one would be the
// same class of error the dispute planner was written to stop, pointed the
// other way. Hence the gate on `movesMoney`.
//
// Reversing the wrong amount. A dispute can be partial. The proportion has to
// be the DISPUTED amount over the charge total, not the charge total over
// itself — otherwise a $20 dispute on a $200 charge hands back the entire fee.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
// Lazy: a read resolved in a describe body turns a missing file into an
// import-time throw, and vitest reports that as "no tests" — which reads as a
// pass. The mutation test for this file stashes src/.
const hook = () => readFileSync(ROOT + "src/routes/api/public/hooks/stripe.ts", "utf8");

/** The dispute half of the reversal handler: from the BUILD-12 note that opens
 *  the `else` down to the `if (kind)` that both branches fall into. Sliced
 *  rather than searched whole-file, because the refund branch a hundred lines
 *  above contains a passing version of everything asserted here — a whole-file
 *  `toMatch` would go green with the dispute branch still empty, which is
 *  exactly the bug. */
function disputeBranch(src: string): string {
  const start = src.indexOf("// BUILD-12: `charge.dispute.created`");
  if (start === -1) throw new Error("dispute branch marker not found");
  const end = src.indexOf("if (kind) {", start);
  if (end === -1) throw new Error("end of dispute branch not found");
  return src.slice(start, end);
}

/** The refund half, for the same-shape comparison. */
function refundBranch(src: string): string {
  const start = src.indexOf('if (event.type === "charge.refunded") {');
  if (start === -1) throw new Error("refund branch not found");
  return src.slice(start, src.indexOf("// BUILD-12: `charge.dispute.created`", start));
}

describe("a lost chargeback gives our commission back", () => {
  it("slices the two branches apart rather than searching the whole file", () => {
    // If this slicing breaks, every assertion below would be reading the wrong
    // region — and the refund branch would satisfy all of them.
    const src = hook();
    const d = disputeBranch(src);
    const r = refundBranch(src);
    expect(d.length).toBeGreaterThan(500);
    expect(r.length).toBeGreaterThan(500);
    expect(d).not.toContain('event.type === "charge.refunded"');
    expect(r).toContain("amount_refunded");
  });

  it("reverses the application fee in the dispute branch at all", () => {
    const d = disputeBranch(hook());
    expect(
      d,
      "a lost chargeback takes the whole charge off the tenant and charges them " +
        "a dispute fee on top; keeping our 50 bps out of that bills a commission " +
        "on money they never kept",
    ).toMatch(/feeReversalCents\(/);
    expect(d).toMatch(/applicationFees\.createRefund\(/);
  });

  it("only on an event that actually moved money, not on an inquiry", () => {
    const d = disputeBranch(hook());
    // planDisputeEvent already distinguishes them; the reversal has to be
    // behind its verdict rather than behind the event name.
    expect(d).toMatch(/if\s*\(\s*movesMoney\s*\)/);
    const gate = d.indexOf("if (movesMoney)");
    const reversal = d.indexOf("applicationFees.createRefund");
    expect(gate).toBeGreaterThan(-1);
    expect(
      reversal > gate,
      "the fee reversal must sit inside the movesMoney gate, not beside it",
    ).toBe(true);
  });

  it("sends a delta against what Stripe already refunded, so replay is a no-op", () => {
    const d = disputeBranch(hook());
    expect(d).toMatch(/amount_refunded/);
    expect(d).toMatch(/const delta = target - Number\(fee\.amount_refunded/);
    expect(d).toMatch(/if\s*\(\s*delta\s*>\s*0\s*\)/);
  });

  it("proportions the reversal on the DISPUTED amount, not the whole charge", () => {
    const d = disputeBranch(hook());
    // feeReversalCents(fee, chargeTotal, refunded) — the third argument is the
    // part that was taken. Passing the charge total there would return the
    // entire fee for a partial dispute.
    const call = /feeReversalCents\(([\s\S]*?)\);/.exec(d);
    expect(call, "feeReversalCents call not found in the dispute branch").toBeTruthy();
    const args = call![1];
    expect(args).toMatch(/chargeTotal/);
    // `amount` is the disputed amount, assigned from obj.amount a few lines up.
    expect(args.trimEnd().endsWith("amount,") || /\bamount\s*,?\s*$/.test(args.trimEnd())).toBe(
      true,
    );
  });

  it("treats the fee as the platform's, never scoping it to the connected account", () => {
    const d = disputeBranch(hook());
    // The refund path calls this out explicitly: application fees belong to the
    // platform, so these calls must not carry { stripeAccount }. A dispute
    // arrives FROM the connected account, which makes the mistake easy here.
    const feeCalls = d.slice(d.indexOf("applicationFees"));
    expect(feeCalls).not.toMatch(/stripeAccount/);
  });

  it("does not let a failed fee reversal cost the tenant their ledger entry", () => {
    const d = disputeBranch(hook());
    // Same isolation the refund path documents: the customer's money and the
    // tenant's alert are the facts that must be right; our fee is reconcilable
    // from Stripe afterwards.
    expect(d).toMatch(/try\s*\{/);
    expect(d).toMatch(/catch\s*\(\s*e\s*\)/);
    expect(d).toMatch(/application fee reversal on dispute failed/);
  });

  it("keeps the refund branch's own reversal intact", () => {
    // Regression guard on the half that already worked.
    const r = refundBranch(hook());
    expect(r).toMatch(/feeReversalCents\(/);
    expect(r).toMatch(/applicationFees\.createRefund\(/);
  });
});
