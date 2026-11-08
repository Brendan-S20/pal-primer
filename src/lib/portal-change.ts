// Portal reschedules and cancels: what the business chose, and what the
// customer is told (#730, decision D6). Pure, so the portal, the office and
// the tests read one copy.

export const PORTAL_CHANGE_POLICIES = ["instant", "approval"] as const;
export type PortalChangePolicy = (typeof PORTAL_CHANGE_POLICIES)[number];

/** What a NEW business starts on. Existing businesses kept "instant" when the
 *  setting arrived (migration 20261108153700). The coordinator's
 *  recommendation for D6, not an owner decision about any one business. */
export const DEFAULT_PORTAL_CHANGE_POLICY: PortalChangePolicy = "approval";

export const PORTAL_CHANGE_POLICY_LABELS: Record<PortalChangePolicy, string> = {
  instant: "Apply instantly",
  approval: "Wait for my approval",
};

export const ONLY_AN_OWNER_CHANGES_PORTAL_POLICY =
  "Only an owner can change how portal changes are handled.";
export const ONLY_AN_OWNER_DECIDES_PORTAL_CHANGES =
  "Only an owner can approve or deny a portal change.";

/** A late-change rule for one service line, as the settings form edits it. */
export type PortalChangeRule = {
  service_line: string;
  /** NULL: the business's portal change cutoff (Settings → Customer portal). */
  cutoff_hours: number | null;
  /** NULL or 0: no late fee for this line. */
  late_window_hours: number | null;
  late_reschedule_fee_cents: number;
  late_cancel_fee_cents: number;
};

/** What the portal is told about one upcoming visit. */
export type PortalVisitChangeTerms = {
  visit_id: string;
  policy: PortalChangePolicy;
  cutoff_at: string | null;
  late_from: string | null;
  reschedule_fee_cents: number;
  cancel_fee_cents: number;
  pending_request_id: string | null;
  pending_kind: "reschedule" | "cancel" | null;
  pending_requested_date: string | null;
};

/** Merge the terms into the upcoming-visit rows. A row with no terms (a read
 *  that failed) is returned as it was: the server still enforces the cutoff
 *  and refuses a fee nobody was shown. A row whose line has its own cutoff
 *  shows that one. */
export function withChangeTerms<
  R extends { visit_id: string; changes_allowed_until?: string | null },
>(
  rows: R[],
  terms: PortalVisitChangeTerms[],
): Array<R & { change_terms?: PortalVisitChangeTerms }> {
  const byId = new Map(terms.map((t) => [t.visit_id, t]));
  return rows.map((r) => {
    const t = byId.get(r.visit_id);
    if (!t) return r;
    return {
      ...r,
      changes_allowed_until: t.cutoff_at ?? r.changes_allowed_until ?? null,
      change_terms: t,
    };
  });
}

/** The fee a change made at `now` would carry. Mirrors the database's
 *  portal_change_fee_now; the database's answer is the one that counts. */
export function feeIfChangedNow(
  terms:
    | Pick<PortalVisitChangeTerms, "late_from" | "reschedule_fee_cents" | "cancel_fee_cents">
    | undefined,
  kind: "reschedule" | "cancel",
  now: number = Date.now(),
): number {
  if (!terms?.late_from) return 0;
  if (now <= new Date(terms.late_from).getTime()) return 0;
  const fee = kind === "reschedule" ? terms.reschedule_fee_cents : terms.cancel_fee_cents;
  return Math.max(0, Number(fee) || 0);
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}

/** Dollars typed in a form, to cents. Blank is 0; anything else must be a
 *  non-negative amount with at most two decimals. */
export function dollarsToCents(input: string): number | null {
  const s = input.trim();
  if (s === "") return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}

// ── Customer-facing copy ──────────────────────────────────────────────────
// OWNER REVIEW: every sentence below is a PLACEHOLDER for the owner to
// approve or rewrite (#730: "pricing and consent wording are owner
// decisions"). They state only facts the server enforces: the amount the
// business configured, when it starts, and whether the business reviews the
// change. None of them promises or describes a refund, a dispute right or a
// legal term.
export const PORTAL_CHANGE_COPY = {
  feeStarts: (fee: string, when: string) =>
    `A late-change fee of ${fee} applies to changes made after ${when}.`,
  feeNow: (fee: string) => `A late-change fee of ${fee} applies to this change.`,
  acceptFee: (fee: string) => `I understand a ${fee} late-change fee applies`,
  needsApproval: "The business reviews this change before it takes effect.",
  sentForApproval: "Sent to the business for approval",
  pendingReschedule: (date: string) => `Reschedule to ${date} is waiting for approval`,
  pendingCancel: "Skip is waiting for approval",
  withdraw: "Withdraw request",
} as const;
