// Churn risk as arithmetic, not as a model call.
//
// `scoreChurn` used to send these seven numbers to a model and ask it for a
// 0-100 score and a sentence. That is a weighted sum with extra steps: it cost
// an AI action per run, it could only be had on a paid plan, the same client
// could score differently on two runs with nothing changed, and an owner
// asking "why is Mrs Patel a 72" had no answer beyond "the model said so".
//
// So the weights are written down here, where they can be read, argued with
// and tested. The reason names the one or two signals that contributed most,
// in the order they contributed, so the sentence and the number always agree.
//
// The weights, and why each is where it is:
//
//   Recency          up to 35  Nothing until 21 days, so a biweekly client is
//                              never penalised for its normal gap. From day 22
//                              it is 15 points plus one per further day, which
//                              reaches the cap at 42 days. The largest weight
//                              because a yard nobody has visited is the
//                              clearest sign the relationship has stopped.
//   Skips (30 days)  up to 25  10 per skip. One skip is a holiday; three is a
//                              client who has stopped wanting the service.
//   Unpaid balance   up to 25  Linear from $0 to $200, where it caps. Plus 5
//                              more for two or more unpaid invoices, because a
//                              second unpaid bill is a pattern and one is not.
//   Complaints (90d) up to 20  8 per concern or re-clean request. Taken from
//                              the second scorer this one replaced (Analytics),
//                              which counted them; a client who keeps
//                              complaining is telling you before they cancel.
//   Failed autopay   up to 15  5 per failed charge, also from that scorer: a
//                              card that keeps declining is often a client who
//                              has stopped paying attention to the bill.
//   Opted out of texts    5    Small: it is as often a preference as a signal.
//   New (< 60 days)      10    New clients cancel more than settled ones.
//   3+ visits done      -10    Recent regular service is the best evidence
//                              the client is staying.
//
// The total is clamped to 0-100 and rounded to a whole number.

export interface ChurnSignals {
  client_id: string;
  display_name: string;
  tenure_days: number;
  /** Days since the last COMPLETED visit, or null when there is none inside
   *  the lookback `gatherChurnSignals` reads (30 days). */
  days_since_last_visit: number | null;
  completed_last_30: number;
  skipped_last_30: number;
  unpaid_invoice_count: number;
  unpaid_total_cents: number;
  sms_opt_out: boolean;
  /** Concerns and re-clean requests in the last 90 days. Optional so a caller
   *  that does not read them scores as before. */
  complaints_last_90?: number;
  /** `clients.autopay_failure_count`. */
  autopay_failures?: number;
}

export interface ChurnScore {
  score: number;
  reason: string;
}

/** Where the recency weight starts. A biweekly client's normal gap is 14 days,
 *  and a week's slack on top of that is not yet a signal. */
export const RECENCY_GRACE_DAYS = 21;
export const RECENCY_MAX = 35;
export const SKIP_POINTS_EACH = 10;
export const SKIP_MAX = 25;
export const UNPAID_MAX = 25;
/** The balance at which the unpaid weight is full. */
export const UNPAID_FULL_AT_CENTS = 20_000;
export const MULTIPLE_UNPAID_BONUS = 5;
export const SMS_OPT_OUT_POINTS = 5;
export const COMPLAINT_POINTS_EACH = 8;
export const COMPLAINT_MAX = 20;
export const AUTOPAY_FAILURE_POINTS_EACH = 5;
export const AUTOPAY_FAILURE_MAX = 15;
export const NEW_CLIENT_DAYS = 60;
export const NEW_CLIENT_POINTS = 10;
export const REGULAR_VISITS = 3;
export const REGULAR_CREDIT = 10;

/** Matches the gather window, so a null last visit can be described honestly. */
const LOOKBACK_DAYS = 30;

function money(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function recencyPoints(days: number): number {
  if (days <= RECENCY_GRACE_DAYS) return 0;
  return Math.min(RECENCY_MAX, 15 + (days - RECENCY_GRACE_DAYS - 1));
}

type Factor = { points: number; phrase: string };

export function scoreChurnSignals(s: ChurnSignals): ChurnScore {
  const factors: Factor[] = [];
  const tenure = Math.max(0, Math.floor(s.tenure_days || 0));

  // Recency. A null means no completed visit inside the lookback. For a client
  // older than the lookback that is at least 30 days without one, which is
  // past the point where the weight is mostly spent, so it takes the full
  // weight. For a newer client the honest gap is its whole tenure: someone who
  // signed up nine days ago and has not been visited yet is not a lapsed
  // client, and scoring them as one would put every new sign-up on the watch
  // list.
  if (s.days_since_last_visit == null) {
    if (tenure >= LOOKBACK_DAYS) {
      factors.push({
        points: RECENCY_MAX,
        phrase: `no completed visit in the last ${LOOKBACK_DAYS} days`,
      });
    } else {
      const p = recencyPoints(tenure);
      if (p > 0) factors.push({ points: p, phrase: "no completed visit yet" });
    }
  } else {
    const days = Math.max(0, Math.floor(s.days_since_last_visit));
    const p = recencyPoints(days);
    if (p > 0) factors.push({ points: p, phrase: `no visit in ${days} days` });
  }

  const skips = Math.max(0, Math.floor(s.skipped_last_30 || 0));
  if (skips > 0) {
    factors.push({
      points: Math.min(SKIP_MAX, skips * SKIP_POINTS_EACH),
      phrase: `${plural(skips, "skipped visit")} in 30 days`,
    });
  }

  // One factor, not two: "$185.00 unpaid" and "2 unpaid invoices" are the
  // same fact, and naming it twice would crowd out the second-biggest signal.
  const unpaidCents = Math.max(0, s.unpaid_total_cents || 0);
  const unpaidCount = Math.max(0, Math.floor(s.unpaid_invoice_count || 0));
  if (unpaidCents > 0 || unpaidCount > 0) {
    const amount = Math.round(UNPAID_MAX * Math.min(1, unpaidCents / UNPAID_FULL_AT_CENTS));
    const bonus = unpaidCount >= 2 ? MULTIPLE_UNPAID_BONUS : 0;
    if (amount + bonus > 0) {
      factors.push({
        points: amount + bonus,
        phrase:
          unpaidCount >= 2
            ? `${money(unpaidCents)} unpaid across ${unpaidCount} invoices`
            : `${money(unpaidCents)} unpaid`,
      });
    }
  }

  const complaints = Math.max(0, Math.floor(s.complaints_last_90 ?? 0));
  if (complaints > 0) {
    factors.push({
      points: Math.min(COMPLAINT_MAX, complaints * COMPLAINT_POINTS_EACH),
      phrase: `${plural(complaints, "complaint")} in 90 days`,
    });
  }

  const autopayFails = Math.max(0, Math.floor(s.autopay_failures ?? 0));
  if (autopayFails > 0) {
    factors.push({
      points: Math.min(AUTOPAY_FAILURE_MAX, autopayFails * AUTOPAY_FAILURE_POINTS_EACH),
      phrase: `${plural(autopayFails, "failed autopay charge")}`,
    });
  }

  if (s.sms_opt_out) factors.push({ points: SMS_OPT_OUT_POINTS, phrase: "opted out of texts" });

  if (tenure < NEW_CLIENT_DAYS) {
    factors.push({
      points: NEW_CLIENT_POINTS,
      phrase: tenure === 1 ? "joined 1 day ago" : `joined ${tenure} days ago`,
    });
  }

  const credit = (s.completed_last_30 || 0) >= REGULAR_VISITS ? REGULAR_CREDIT : 0;
  const raw = factors.reduce((sum, f) => sum + f.points, 0) - credit;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  // Biggest first. The sort is stable, so a tie keeps the order the factors
  // were pushed in above, and the same signals always produce the same words.
  const top = [...factors].sort((a, b) => b.points - a.points).slice(0, 2);
  let reason: string;
  if (top.length === 0) {
    reason = "Visiting regularly with nothing unpaid.";
  } else {
    const text = top.map((f) => f.phrase).join(" and ");
    // When the regular-visits credit pulled the number down, say so. Without
    // it "Joined 20 days ago." sits beside a score of 0 and reads as a
    // contradiction.
    const offset = credit
      ? `; ${plural(s.completed_last_30, "visit")} completed in 30 days`
      : "";
    reason = `${text[0].toUpperCase()}${text.slice(1)}${offset}.`;
  }
  return { score, reason };
}
