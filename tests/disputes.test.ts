import { describe, expect, it } from "vitest";
import {
  DISPUTE_COPY,
  DISPUTE_KINDS,
  DISPUTE_OUTCOMES,
  disputeFrom,
  disputeReducesAnalyticsRevenue,
  disputesFrom,
  summarizeDisputes,
  type DisputeEvent,
} from "@/lib/disputes";
import { REVERSAL_KINDS, reducesIncome } from "@/lib/cpa-reports";

// BUILD-12. The dangerous cases here are the ones where a wrong answer still
// looks like a plausible number: a lost dispute silently adding money back, a
// display toggle leaking into a tax figure, or an outcome inferred from age.

const ev = (kind: string, day: string, amountCents = 100_000): DisputeEvent => ({
  kind,
  day,
  amountCents,
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
      { paymentId: "a", outcome: "open", amountCents: 10_000, openedOn: "2026-05-01", decidedOn: null },
      { paymentId: "b", outcome: "open", amountCents: 5_000, openedOn: "2026-05-02", decidedOn: null },
      { paymentId: "c", outcome: "lost", amountCents: 7_500, openedOn: "2026-04-01", decidedOn: "2026-05-01" },
      { paymentId: "d", outcome: "won", amountCents: 2_500, openedOn: "2026-03-01", decidedOn: "2026-04-01" },
    ]);
    expect(totals).toEqual({
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
