// QA-P3 — the sentences the weekly digest puts in front of an owner.
//
// Pulled out of digest.server.ts because they are pure, and because the one
// that was WRONG had been wrong in an emailed report with nothing able to
// notice. `computeDigestMetrics` needs a database and a live org to run, so
// every string it produced was only ever checked by reading it.
//
// ── THE BUG ───────────────────────────────────────────────────────────────
//
// The receivables alert read:
//
//     `${overdueCount} overdue invoices totaling ${fmt(openArCents)}`
//
// — the number of OVERDUE invoices, attached to the total of ALL OPEN ones.
// Live, that produced "10 overdue invoices totaling $2,725.00" when the ten
// overdue invoices came to $2,550.00. The extra $175.00 was five invoices
// that were open and simply not due yet.
//
// `summarizeAr` had returned both figures all along. The alert destructured
// the count from one and the money from the other.
//
// It matters because of what the sentence is FOR. An owner reads it and
// decides who to chase this week, and the figure is their sense of how big
// the problem is. Inflating it by everything not yet due points them at
// customers who are not late — and this string is EMAILED, so the wrong
// number left the building rather than merely appearing on a screen.

export function formatCents(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

export type DigestAlertInput = {
  /** How many invoices are past their due date. */
  overdueCount: number;
  /** What THOSE invoices come to — not the whole open ledger. */
  overdueCents: number;
  complaintsCount: number;
  visitsSkipped: number;
  visitsCompleted: number;
};

/** Above this share of a week's visits, skipping stops being noise. */
export const SKIP_RATE_ALERT_THRESHOLD = 0.1;

/**
 * What is worth telling the owner about this week, in the order it matters.
 *
 * Every alert is a claim about their business, so each one names both the
 * count and the quantity behind it — a bare "you have overdue invoices" is
 * not actionable, and a quantity attached to the wrong count is worse than
 * either on its own.
 */
export function buildDigestAlerts(m: DigestAlertInput): string[] {
  const alerts: string[] = [];

  if (m.overdueCount > 0) {
    alerts.push(
      `${m.overdueCount} overdue invoice${m.overdueCount === 1 ? "" : "s"} totaling ${formatCents(m.overdueCents)}.`,
    );
  }

  if (m.complaintsCount > 0) {
    alerts.push(
      `${m.complaintsCount} client complaint${m.complaintsCount === 1 ? "" : "s"} logged this week.`,
    );
  }

  // Guarded on completed > 0 as well as skipped > 0: a week with three skips
  // and no completions is 100%, which is true and useless — it describes an
  // org that did not work that week, not one with a skip problem.
  const total = m.visitsSkipped + m.visitsCompleted;
  if (
    m.visitsSkipped > 0 &&
    m.visitsCompleted > 0 &&
    m.visitsSkipped / total > SKIP_RATE_ALERT_THRESHOLD
  ) {
    const rate = Math.round((m.visitsSkipped / total) * 100);
    alerts.push(`Skip rate is ${rate}%, above the ${SKIP_RATE_ALERT_THRESHOLD * 100}% threshold.`);
  }

  return alerts;
}
