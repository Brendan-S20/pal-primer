// Unified activity timeline writer (client detail refactor).
//
// Server functions call logActivity after a successful mutation. Failures
// are swallowed with a console warning: the audit trail must never break
// the operation it is describing.

export interface ActivityEntry {
  orgId: string;
  clientId?: string | null;
  propertyId?: string | null;
  subscriptionId?: string | null;
  /** Omit for system events written via the service-role client (webhooks,
   * nightly jobs) — pair those with an actorLabel like "Stripe". */
  actorUserId?: string | null;
  actorLabel?: string | null;
  /** Stable machine kind, e.g. "client.updated", "service.paused". */
  kind: string;
  /** Human sentence shown on the timeline. */
  summary: string;
  meta?: Record<string, unknown>;
}

export async function logActivity(supabase: any, entry: ActivityEntry): Promise<void> {
  const { error } = await supabase.from("activity_log").insert({
    organization_id: entry.orgId,
    client_id: entry.clientId ?? null,
    property_id: entry.propertyId ?? null,
    subscription_id: entry.subscriptionId ?? null,
    actor_user_id: entry.actorUserId ?? null,
    actor_label: entry.actorLabel ?? null,
    kind: entry.kind,
    summary: entry.summary.slice(0, 500),
    meta: entry.meta ?? {},
  });
  if (error) console.warn("activity_log insert failed:", error.message);
}
