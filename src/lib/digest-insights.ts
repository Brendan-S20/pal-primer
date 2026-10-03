// The digest's and the Business Advisor's commentary, written as rules.
//
// Both used to send the period's metrics to a model and ask for a headline,
// a few observations and a few next steps. Every input was a number we had
// already computed, and every useful output was a comparison of two of them or
// a threshold crossed, which is arithmetic. The model added cost (one AI
// action per digest, per org, every Monday, unasked), a paid-plan gate, and
// prose that could state a figure the metrics did not contain. When it was
// unreachable the code fell back to a deterministic version of the same thing,
// and the owner was told the fallback was "basic". This is that version, made
// the only one and made better, so there is nothing to fall back from.
//
// Pure, like digest-alerts.ts beside it, so every sentence an owner reads can
// be checked by a test instead of only by reading an email.

import { formatCents } from "@/lib/digest-alerts";

export interface DigestInsights {
  headline: string;
  insights: string[];
  recommendations: string[];
}

/** The parts of DigestMetrics the commentary reads. Structural rather than
 *  imported, so this module does not pull the server file in with it. */
export interface DigestInsightsInput {
  windowDays?: number;
  alerts: string[];
  raw: {
    revenueCents: number;
    revenueGrossCents: number;
    refundsCents: number;
    prevRevenueCents: number;
    visitsCompleted: number;
    visitsSkipped: number;
    newClients: number;
    openArCents: number;
    overdueCents: number;
    overdueInvoices: number;
    atRiskCount: number;
    complaintsCount: number;
  };
}

function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

/** "the previous 7 days", "the previous 30 days". Not "last week": the
 *  Advisor runs the same engine over 30 and 90 days. */
function previousPeriod(windowDays: number | undefined) {
  return `the previous ${windowDays ?? 7} days`;
}

function revenueMovement(now: number, prev: number, windowDays?: number): string {
  const period = previousPeriod(windowDays);
  if (prev <= 0) {
    return now > 0
      ? `Revenue was ${formatCents(now)}, with nothing collected in ${period}.`
      : `No revenue was collected in this period or ${period}.`;
  }
  const change = Math.round(((now - prev) / prev) * 100);
  if (change === 0) return `Revenue was ${formatCents(now)}, level with ${period}.`;
  return `Revenue was ${formatCents(now)}, ${change > 0 ? "up" : "down"} ${Math.abs(change)}% on ${period} (${formatCents(prev)}).`;
}

export function buildDigestInsights(m: DigestInsightsInput): DigestInsights {
  const r = m.raw;

  const headline = `Revenue of ${formatCents(r.revenueCents)} across ${plural(r.visitsCompleted, "completed visit")}.`;

  const insights: string[] = [revenueMovement(r.revenueCents, r.prevRevenueCents, m.windowDays)];

  // Named whenever there is one. A reversal and a slow week call for
  // different responses, and the net figure alone cannot tell them apart.
  if (r.refundsCents > 0) {
    insights.push(
      `${formatCents(r.refundsCents)} went back out in refunds and chargebacks, from ${formatCents(r.revenueGrossCents)} collected.`,
    );
  }

  insights.push(
    `You added ${plural(r.newClients, "new client")} and completed ${plural(r.visitsCompleted, "visit")}` +
      (r.visitsSkipped > 0 ? `, with ${r.visitsSkipped} skipped.` : "."),
  );

  // Both receivables figures, separately labelled. Pairing the overdue count
  // with the whole open balance is the mistake digest-alerts.ts was written
  // to fix, and it must not come back in a second sentence.
  if (r.openArCents > 0) {
    insights.push(
      r.overdueInvoices > 0
        ? `Open A/R is ${formatCents(r.openArCents)}, of which ${formatCents(r.overdueCents)} is overdue across ${plural(r.overdueInvoices, "invoice")}.`
        : `Open A/R is ${formatCents(r.openArCents)}, none of it overdue.`,
    );
  }

  // The alerts are already the prioritised list of what needs doing; the
  // general advice only fills the space when nothing is wrong.
  const recommendations = m.alerts.length
    ? m.alerts.slice(0, 3)
    : [
        "Confirm next week's schedule and send route reminders to techs.",
        r.atRiskCount > 0
          ? `Review the ${plural(r.atRiskCount, "at-risk client")} in Analytics, Win-back.`
          : "Ask a happy client this week for a review.",
      ];

  return { headline, insights, recommendations };
}

// ── the dashboard's weekly digest panel ───────────────────────────────────

/** What `generateWeeklyDigest` gathers. Field names match what DigestPanel
 *  already reads off `stats`. */
export interface WeeklyDigestStats {
  org: string;
  completed: number;
  skipped: number;
  scheduled: number;
  completion_rate: number;
  revenue_collected_cents: number;
  revenue_collected_gross_cents: number;
  refunds_chargebacks_cents: number;
  refunds_chargebacks_count: number;
  revenue_invoiced_cents: number;
  open_invoices: number;
  new_clients: number;
  new_leads: number;
  at_risk: Array<{ display_name: string; churn_score: number | null }>;
}

/** The panel's summary, in the sections the model was asked for, built from
 *  the same numbers and nothing else. MarkdownLite renders it. */
export function buildWeeklyDigestSummary(s: WeeklyDigestStats): string {
  const lines: string[] = [];

  lines.push("### This week");
  lines.push(
    `- ${plural(s.completed, "visit")} completed of ${s.scheduled} scheduled (${s.completion_rate}%).`,
  );
  if (s.skipped > 0) lines.push(`- ${plural(s.skipped, "visit")} skipped.`);

  lines.push("", "### Money");
  lines.push(
    s.refunds_chargebacks_cents > 0
      ? `- Collected ${formatCents(s.revenue_collected_cents)} after ${formatCents(s.refunds_chargebacks_cents)} in refunds and chargebacks (${formatCents(s.revenue_collected_gross_cents)} before them).`
      : `- Collected ${formatCents(s.revenue_collected_cents)}.`,
  );
  lines.push(`- Invoiced ${formatCents(s.revenue_invoiced_cents)}.`);
  if (s.open_invoices > 0) {
    lines.push(`- ${plural(s.open_invoices, "invoice")} issued this week ${s.open_invoices === 1 ? "is" : "are"} still open.`);
  }

  lines.push("", "### Growth");
  lines.push(`- ${plural(s.new_clients, "new client")} and ${plural(s.new_leads, "new lead")}.`);

  lines.push("", "### Watch list");
  lines.push(
    s.at_risk.length
      ? `- ${plural(s.at_risk.length, "client")} with a churn score of 70 or more, listed below.`
      : "- No clients with a churn score of 70 or more.",
  );

  const actions: string[] = [];
  const top = s.at_risk[0];
  if (top) actions.push(`Call ${top.display_name} first: the highest churn score this week.`);
  if (s.open_invoices > 0) actions.push(`Follow up on the ${plural(s.open_invoices, "open invoice")} from this week.`);
  const worked = s.completed + s.skipped;
  if (s.skipped > 0 && s.completed > 0 && s.skipped / worked > 0.1) {
    actions.push(`Find out why ${plural(s.skipped, "visit was", "visits were")} skipped.`);
  }
  if (s.new_leads > 0) actions.push(`Reply to the ${plural(s.new_leads, "new lead")}.`);
  if (actions.length < 2) actions.push("Ask a happy client for a review.");

  lines.push("", "### Next steps");
  for (const a of actions.slice(0, 3)) lines.push(`- ${a}`);

  return lines.join("\n");
}
