// Pure read-side helpers for the platform audit log.
//
// Extracted from the route so they can be tested. The filter in particular:
// it used to search action / org / actor only, while the row RENDERED the
// impersonated user's email. So "who did we impersonate as bob@…" — the single
// most likely question anyone brings to this page — returned no matches
// against text that was visibly on screen. A filter that can't find what it
// displays is worse than no filter, because it reads as a definitive "no".

export interface AuditSearchRow {
  action: string;
  organization_name: string | null;
  actor_email: string | null;
  actor_user_id: string | null;
  after_json: unknown;
}

/** Who to credit a row to.
 *
 *  `actor_user_id` became nullable when the platform Stripe webhook started
 *  filing `billing_status_change` — a webhook has no actor, and inventing one
 *  would put a name on an act nobody performed, in the one table whose job is
 *  saying who did what. Both routes rendered `actor_user_id.slice(0, 8)`, which
 *  a null would have crashed on, so the label lives here once rather than being
 *  guarded twice.
 *
 *  Truthiness rather than ??, so an empty string is treated as absent: "by "
 *  with nothing after it is the one output this must never render. */
export function auditActorLabel(row: {
  actor_email: string | null;
  actor_user_id: string | null;
}): string {
  return row.actor_email || row.actor_user_id?.slice(0, 8) || "the billing system";
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** Everything a row is searchable by. Kept in step with what the row renders —
 *  that equivalence is the point of the helper. */
export function auditSearchTerms(row: AuditSearchRow): string[] {
  const after = asRecord(row.after_json);
  return [
    row.action,
    row.organization_name,
    row.actor_email,
    row.actor_user_id,
    // The impersonation target: shown inline on the row, so it must be
    // findable. Both forms, since older events may carry only the id.
    after.target_email,
    after.target_user_id,
  ]
    .filter((v): v is string => typeof v === "string" && v.length > 0);
}

export function auditRowMatches(row: AuditSearchRow, filter: string): boolean {
  const f = filter.trim().toLowerCase();
  if (!f) return true;
  return auditSearchTerms(row).some((s) => s.toLowerCase().includes(f));
}

function formatDuration(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins > 0 ? `${mins}m ` : ""}${secs}s`;
}

/**
 * The inline summary for an impersonation event: who was impersonated, and for
 * how long.
 *
 * Duration is deliberately not always available. A session exited with the
 * button was measured end to end. A session abandoned by closing the tab was
 * not — the nightly sweep only knows when the window closed. Reporting a
 * full-window duration for the second case would be inventing a fact, so it
 * says what happened instead.
 */
export function impersonationDetail(row: {
  action: string;
  after_json: unknown;
}): string | null {
  if (!row.action.includes("impersonation")) return null;
  const a = asRecord(row.after_json);
  const target = a.target_email ?? a.target_user_id ?? null;

  const parts: string[] = [];
  if (typeof target === "string" && target) parts.push(`as ${target}`);
  if (typeof a.duration_seconds === "number") {
    parts.push(`for ${formatDuration(a.duration_seconds)}`);
  } else if (a.ended_reason === "expired") {
    parts.push("ended at the time limit, no exit recorded");
  }
  return parts.length ? parts.join(" · ") : null;
}
