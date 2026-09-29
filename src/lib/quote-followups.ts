/** When an unanswered quote gets its one reminder. Pure; the sender is
 *  quote-followups.server.ts, called from the nightly job. */

const DAY_MS = 86_400_000;

export type FollowupCandidate = {
  status: string;
  sent_at: string | null;
  valid_until: string | null;
  followup_sent_at: string | null;
};

/** Due when: still sent (not accepted, declined, withdrawn), sent at least
 *  `days` days ago, not reminded yet, and still acceptable today on the
 *  business's calendar. A reminder about a quote the customer can no longer
 *  accept would only send them to a page that says so. `days` of 0 is off. */
export function followupDue(
  q: FollowupCandidate,
  p: { days: number; orgToday: string; now: Date },
): boolean {
  if (p.days <= 0) return false;
  if (q.status !== "sent" || !q.sent_at || q.followup_sent_at) return false;
  if (q.valid_until && q.valid_until < p.orgToday) return false;
  return Date.parse(q.sent_at) <= p.now.getTime() - p.days * DAY_MS;
}
