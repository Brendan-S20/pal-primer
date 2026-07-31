import { describe, expect, it } from "vitest";
import {
  DISPUTE_COPY,
  DISPUTE_KINDS,
  DISPUTE_OUTCOMES,
  disputeFrom,
  disputeKey,
  disputeReducesAnalyticsRevenue,
  disputeStatusMovedMoney,
  disputesFrom,
  paymentIsReversedByDisputes,
  planDisputeEvent,
  summarizeDisputes,
  type DisputeEvent,
} from "@/lib/disputes";
import { REVERSAL_KINDS, reducesIncome } from "@/lib/cpa-reports";

// BUILD-12. The dangerous cases here are the ones where a wrong answer still
// looks like a plausible number: a lost dispute silently adding money back, a
// display toggle leaking into a tax figure, or an outcome inferred from age.

const ev = (
  kind: string,
  day: string,
  amountCents = 100_000,
  disputeId = "",
): DisputeEvent => ({
  kind,
  day,
  amountCents,
  disputeId,
});

// ── An inquiry is not a chargeback ─────────────────────────────────────────
//
// The defect these pin: Stripe's `warning_*` statuses withdraw NO funds, and
// the handler read every `charge.dispute.created` as a withdrawal and every
// non-`won` `charge.dispute.closed` as a loss. A $600 inquiry that the bank
// simply dropped therefore deducted $600 from revenue for ever, billed a
// franchise location $600, and told the owner they had lost.

describe("which dispute statuses actually moved money", () => {
  it("says no for every inquiry status", () => {
    for (const s of ["warning_needs_response", "warning_under_review", "warning_closed"]) {
      expect(disputeStatusMovedMoney(s), s).toBe(false);
    }
  });

  it("says no for a PREVENTED dispute", () => {
    // Rapid Dispute Resolution / Order Insight stop the chargeback. If the
    // customer got their money it arrived as a REFUND, and charge.refunded
    // records that separately — deducting here too would take it twice.
    expect(disputeStatusMovedMoney("prevented")).toBe(false);
  });

  it("says yes for a real chargeback in every one of its states", () => {
    for (const s of ["needs_response", "under_review", "won", "lost"]) {
      expect(disputeStatusMovedMoney(s), s).toBe(true);
    }
  });

  it("treats an unknown warning_* status as an inquiry", () => {
    // The safe direction for a status Stripe adds later: a new inquiry state
    // read as a chargeback would deduct real revenue the day it first appears.
    expect(disputeStatusMovedMoney("warning_something_new")).toBe(false);
  });

  it("treats any OTHER unknown status as a real chargeback", () => {
    // The other safe direction: an unrecognised genuine dispute is still
    // recorded as a withdrawal rather than quietly ignored.
    expect(disputeStatusMovedMoney("some_new_dispute_state")).toBe(true);
  });
});

describe("planning a charge.dispute.* webhook", () => {
  it("files an inquiry — visible, but moving nothing — when one opens", () => {
    const p = planDisputeEvent("charge.dispute.created", "warning_needs_response");
    expect(p.kind).toBe("dispute_inquiry");
    expect(p.movesMoney).toBe(false);
  });

  it("does NOT call a dropped inquiry a lost chargeback", () => {
    // The headline bug. warning_closed is the GOOD ending: the bank's question
    // went away and nothing was ever taken.
    const p = planDisputeEvent("charge.dispute.closed", "warning_closed");
    expect(p.kind).toBe("dispute_inquiry_closed");
    expect(p.kind).not.toBe("chargeback_lost");
    expect(p.movesMoney).toBe(false);
  });

  it("records a real chargeback as money leaving", () => {
    const p = planDisputeEvent("charge.dispute.created", "needs_response");
    expect(p).toEqual({ kind: "chargeback", movesMoney: true });
  });

  it("records a win as money coming back", () => {
    expect(planDisputeEvent("charge.dispute.closed", "won")).toEqual({
      kind: "chargeback_won",
      movesMoney: true,
    });
  });

  it("records a loss as status only", () => {
    // The money left when the dispute opened. Moving it again would deduct the
    // same amount twice and bill a franchise location for it twice.
    expect(planDisputeEvent("charge.dispute.closed", "lost")).toEqual({
      kind: "chargeback_lost",
      movesMoney: false,
    });
  });

  it("never bills anything for an inquiry, open or closed", () => {
    for (const s of ["warning_needs_response", "warning_under_review", "warning_closed", "prevented"]) {
      expect(planDisputeEvent("charge.dispute.created", s).movesMoney, s).toBe(false);
      expect(planDisputeEvent("charge.dispute.closed", s).movesMoney, s).toBe(false);
    }
  });

  it("does nothing at all for an event it does not handle", () => {
    expect(planDisputeEvent("charge.dispute.updated", "needs_response").kind).toBeNull();
    expect(planDisputeEvent("charge.refunded", null).kind).toBeNull();
  });
});

describe("a lost dispute must never be treated as money moving", () => {
  it("is NOT in the reversal ledger's kinds", () => {
    // The trap. `reducesIncome` returns false for anything that is not a refund
    // or an open chargeback, so if payment_chargeback_lost were added to
    // REVERSAL_KINDS the ledger would classify it as a RECOVERY and ADD the
    // money back — turning a lost dispute into a refund of itself. The
    // withdrawal is already recorded by payment_chargeback.
    expect(REVERSAL_KINDS as readonly string[]).not.toContain("payment_chargeback_lost");
  });

  it("would be counted as a recovery if anyone ever added it", () => {
    // Pinning WHY the previous test matters, so a future reader does not
    // "helpfully" complete the list.
    expect(reducesIncome("payment_chargeback_lost")).toBe(false);
  });

  it("is in the DISPUTE kinds, because it is a status fact", () => {
    expect(DISPUTE_KINDS).toContain("payment_chargeback_lost");
  });

  it("keeps both INQUIRY kinds out of the reversal ledger entirely", () => {
    // An inquiry withdrew nothing, so it must not appear as a deduction OR as
    // a recovery. Adding either to REVERSAL_KINDS would move money that the
    // bank never touched — in the CPA pack, which goes on a tax return.
    for (const k of ["payment_dispute_inquiry", "payment_dispute_inquiry_closed"]) {
      expect(REVERSAL_KINDS as readonly string[], k).not.toContain(k);
      expect(reducesIncome(k), k).toBe(false);
    }
  });
});

describe("an inquiry is a dispute you can see but have not paid for", () => {
  it("is its own outcome, not 'open'", () => {
    const d = disputeFrom("p1", [ev("payment_dispute_inquiry", "2026-04-05", 60_000)]);
    expect(d?.outcome).toBe("inquiry");
    expect(d?.moneyLeft).toBe(false);
  });

  it("closing one is the GOOD ending, not a loss", () => {
    const d = disputeFrom("p1", [
      ev("payment_dispute_inquiry", "2026-04-05", 60_000),
      ev("payment_dispute_inquiry_closed", "2026-05-01", 60_000),
    ]);
    expect(d?.outcome).toBe("inquiry_closed");
    expect(d?.moneyLeft).toBe(false);
    expect(d?.decidedOn).toBe("2026-05-01");
  });

  it("becomes a real dispute if the same dispute is promoted to a chargeback", () => {
    // Stripe can turn an inquiry into a chargeback in place. Once it has, the
    // money HAS gone, so the chargeback has to win the fold.
    const d = disputeFrom("p1", [
      ev("payment_dispute_inquiry", "2026-04-05", 60_000),
      ev("payment_chargeback", "2026-04-20", 60_000),
    ]);
    expect(d?.outcome).toBe("open");
    expect(d?.moneyLeft).toBe(true);
    expect(d?.openedOn).toBe("2026-04-20");
  });

  it("deducts nothing from analytics, whichever way the toggle is set", () => {
    for (const include of [true, false]) {
      expect(disputeReducesAnalyticsRevenue("inquiry", include)).toBe(false);
      expect(disputeReducesAnalyticsRevenue("inquiry_closed", include)).toBe(false);
    }
  });

  it("puts no inquiry money in the lost or open buckets", () => {
    const totals = summarizeDisputes([
      ...disputesFrom([
        { paymentId: "p", ...ev("payment_dispute_inquiry", "2026-05-01", 60_000, "dp_1") },
        { paymentId: "q", ...ev("payment_dispute_inquiry", "2026-05-02", 20_000, "dp_2") },
        { paymentId: "q", ...ev("payment_dispute_inquiry_closed", "2026-05-09", 20_000, "dp_2") },
      ]),
    ]);
    expect(totals.inquiryCount).toBe(1);
    expect(totals.inquiryCents).toBe(60_000);
    // The closed one is counted nowhere: it took nothing and is owed nothing.
    expect(totals.openCents + totals.lostCents + totals.wonCents).toBe(0);
  });
});

// ── A payment can be disputed more than once ───────────────────────────────

describe("two disputes on one payment", () => {
  const rows = [
    { paymentId: "p", ...ev("payment_chargeback", "2026-03-01", 40_000, "dp_first") },
    { paymentId: "p", ...ev("payment_chargeback", "2026-05-01", 60_000, "dp_second") },
  ];

  it("keeps them apart instead of losing the second", () => {
    // review_items was unique on (org, kind, subject) with ON CONFLICT DO
    // NOTHING, so the second dispute — the one with a live evidence deadline —
    // never reached the queue at all.
    const out = disputesFrom(rows);
    expect(out).toHaveLength(2);
    expect(out.map((d) => d.disputeId)).toEqual(["dp_second", "dp_first"]);
    expect(out.map((d) => d.amountCents)).toEqual([60_000, 40_000]);
  });

  it("totals BOTH amounts, not just the larger", () => {
    expect(summarizeDisputes(disputesFrom(rows)).openCents).toBe(100_000);
  });

  it("decides each one on its own events", () => {
    const out = disputesFrom([
      ...rows,
      { paymentId: "p", ...ev("payment_chargeback_won", "2026-06-01", 60_000, "dp_second") },
    ]);
    const byId = new Map(out.map((d) => [d.disputeId, d]));
    expect(byId.get("dp_second")?.outcome).toBe("won");
    // The win must not decide the other one. Folding by payment reported "Won —
    // money returned" for a payment the bank had only half given back.
    expect(byId.get("dp_first")?.outcome).toBe("open");
  });

  it("keeps the payment reversed while ANY dispute still holds its money", () => {
    // The status flip that restored $1,000 of gross revenue the bank was still
    // holding: one win on a twice-disputed payment set it back to 'succeeded'.
    const out = disputesFrom([
      ...rows,
      { paymentId: "p", ...ev("payment_chargeback_won", "2026-06-01", 60_000, "dp_second") },
    ]);
    expect(paymentIsReversedByDisputes(out)).toBe(true);
  });

  it("releases the payment only when every dispute is settled in our favour", () => {
    const out = disputesFrom([
      { paymentId: "p", ...ev("payment_chargeback", "2026-03-01", 40_000, "dp_first") },
      { paymentId: "p", ...ev("payment_chargeback_won", "2026-04-01", 40_000, "dp_first") },
      { paymentId: "p", ...ev("payment_dispute_inquiry", "2026-05-01", 60_000, "dp_second") },
    ]);
    expect(paymentIsReversedByDisputes(out)).toBe(false);
  });

  it("a LOST dispute still holds the money down", () => {
    const out = disputesFrom([
      { paymentId: "p", ...ev("payment_chargeback", "2026-03-01", 40_000, "dp_first") },
      { paymentId: "p", ...ev("payment_chargeback_lost", "2026-04-01", 40_000, "dp_first") },
    ]);
    expect(paymentIsReversedByDisputes(out)).toBe(true);
  });

  it("still groups pre-dispute-id rows together, which is right for them", () => {
    // Rows filed before the id was recorded carry "". The old schema could not
    // hold two of them, so grouping them as one dispute is faithful.
    const out = disputesFrom([
      { paymentId: "p", ...ev("payment_chargeback", "2026-03-01", 40_000) },
      { paymentId: "p", ...ev("payment_chargeback_lost", "2026-04-01", 40_000) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].outcome).toBe("lost");
    expect(out[0].disputeId).toBe("");
  });

  it("keys a dispute by payment AND dispute id", () => {
    expect(disputeKey("p", "dp_1")).not.toBe(disputeKey("p", "dp_2"));
    expect(disputeKey("p", undefined)).toBe(disputeKey("p", ""));
  });
});

describe("folding events into an outcome", () => {
  it("is open when only the withdrawal has been recorded", () => {
    const d = disputeFrom("p1", [ev("payment_chargeback", "2026-04-05")]);
    expect(d?.outcome).toBe("open");
    expect(d?.decidedOn).toBeNull();
    expect(d?.amountCents).toBe(100_000);
  });

  it("is lost when the closure was recorded against us", () => {
    const d = disputeFrom("p1", [
      ev("payment_chargeback", "2026-04-05"),
      ev("payment_chargeback_lost", "2026-06-01"),
    ]);
    expect(d?.outcome).toBe("lost");
    expect(d?.decidedOn).toBe("2026-06-01");
  });

  it("is won when the money came back", () => {
    const d = disputeFrom("p1", [
      ev("payment_chargeback", "2026-04-05"),
      ev("payment_chargeback_won", "2026-06-20"),
    ]);
    expect(d?.outcome).toBe("won");
  });

  it("prefers WON if both a win and a loss somehow exist", () => {
    // Out-of-order webhooks are real. Reading this as lost would tell an owner
    // they are out money they are actually holding, which is the worse error.
    const d = disputeFrom("p1", [
      ev("payment_chargeback", "2026-04-05"),
      ev("payment_chargeback_lost", "2026-06-01"),
      ev("payment_chargeback_won", "2026-06-20"),
    ]);
    expect(d?.outcome).toBe("won");
  });

  it("reports the amount from the OPENING event, not the closure", () => {
    // The closure carries Stripe's amount too, and trusting whichever arrived
    // last would let a differing figure silently restate the loss.
    const d = disputeFrom("p1", [
      ev("payment_chargeback", "2026-04-05", 100_000),
      ev("payment_chargeback_lost", "2026-06-01", 999_999),
    ]);
    expect(d?.amountCents).toBe(100_000);
  });

  it("is not a dispute at all without an opening event", () => {
    // A stray win/loss means we missed the opening. We cannot say what was
    // disputed or for how much, so it is omitted rather than guessed at.
    expect(disputeFrom("p1", [ev("payment_chargeback_won", "2026-06-20")])).toBeNull();
    expect(disputeFrom("p1", [ev("payment_chargeback_lost", "2026-06-01")])).toBeNull();
  });

  it("never infers a loss from age", () => {
    // Guardrail 10.5 — ambiguous records are surfaced, never guessed. A dispute
    // open for two years is still open until Stripe says otherwise.
    const d = disputeFrom("p1", [ev("payment_chargeback", "2024-01-01")]);
    expect(d?.outcome).toBe("open");
  });
});

describe("grouping many payments", () => {
  it("keeps each payment's dispute separate and sorts newest first", () => {
    const rows = [
      { paymentId: "old", ...ev("payment_chargeback", "2026-01-10") },
      { paymentId: "new", ...ev("payment_chargeback", "2026-05-10", 50_000) },
      { paymentId: "new", ...ev("payment_chargeback_won", "2026-06-10", 50_000) },
    ];
    const out = disputesFrom(rows);
    expect(out.map((d) => d.paymentId)).toEqual(["new", "old"]);
    expect(out[0].outcome).toBe("won");
    expect(out[1].outcome).toBe("open");
  });

  it("ignores refunds and any non-dispute kind", () => {
    const rows = [
      { paymentId: "p", ...ev("payment_refunded", "2026-05-10") },
      { paymentId: "p", ...ev("visit_stuck_in_progress", "2026-05-10") },
    ];
    expect(disputesFrom(rows)).toEqual([]);
  });

  it("drops events with no payment to attach to", () => {
    expect(disputesFrom([{ paymentId: null, ...ev("payment_chargeback", "2026-05-10") }])).toEqual(
      [],
    );
  });
});

describe("the analytics toggle", () => {
  it("only ever changes an OPEN dispute", () => {
    // A won dispute never reduced anything; a lost one always does. The toggle
    // can only touch the genuinely undecided middle — which is the only case an
    // owner could hold a defensible opinion about.
    for (const include of [true, false]) {
      expect(disputeReducesAnalyticsRevenue("won", include)).toBe(false);
      expect(disputeReducesAnalyticsRevenue("lost", include)).toBe(true);
    }
    expect(disputeReducesAnalyticsRevenue("open", false)).toBe(true);
    expect(disputeReducesAnalyticsRevenue("open", true)).toBe(false);
  });

  it("defaults to deducting, because the money has actually gone", () => {
    expect(disputeReducesAnalyticsRevenue("open", false)).toBe(true);
  });
});

describe("queue totals", () => {
  it("splits money and counts by outcome", () => {
    const totals = summarizeDisputes([
      { paymentId: "a", disputeId: "dp_a", outcome: "open", amountCents: 10_000, openedOn: "2026-05-01", decidedOn: null, moneyLeft: true },
      { paymentId: "b", disputeId: "dp_b", outcome: "open", amountCents: 5_000, openedOn: "2026-05-02", decidedOn: null, moneyLeft: true },
      { paymentId: "c", disputeId: "dp_c", outcome: "lost", amountCents: 7_500, openedOn: "2026-04-01", decidedOn: "2026-05-01", moneyLeft: true },
      { paymentId: "d", disputeId: "dp_d", outcome: "won", amountCents: 2_500, openedOn: "2026-03-01", decidedOn: "2026-04-01", moneyLeft: false },
      { paymentId: "e", disputeId: "dp_e", outcome: "inquiry", amountCents: 60_000, openedOn: "2026-05-03", decidedOn: null, moneyLeft: false },
    ]);
    expect(totals).toEqual({
      inquiryCount: 1,
      inquiryCents: 60_000,
      openCount: 2,
      openCents: 15_000,
      lostCount: 1,
      lostCents: 7_500,
      wonCount: 1,
      wonCents: 2_500,
    });
  });

  it("is all zeroes for an org that has never had one", () => {
    expect(summarizeDisputes([])).toEqual({
      inquiryCount: 0,
      inquiryCents: 0,
      openCount: 0,
      openCents: 0,
      lostCount: 0,
      lostCents: 0,
      wonCount: 0,
      wonCents: 0,
    });
  });
});

describe("copy", () => {
  it("describes every outcome", () => {
    for (const o of DISPUTE_OUTCOMES) {
      expect(DISPUTE_COPY[o].label).toBeTruthy();
      expect(DISPUTE_COPY[o].whatItMeans.length).toBeGreaterThan(30);
    }
  });

  it("does not tell someone money moved when a dispute is lost", () => {
    // The withdrawal happened when it opened. Copy implying a second hit would
    // have an owner hunting a debit that does not exist.
    expect(DISPUTE_COPY.lost.whatItMeans).toMatch(/left when the dispute opened|not coming back/i);
  });
});
