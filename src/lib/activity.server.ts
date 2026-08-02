// Unified activity timeline writer (client detail refactor).
//
// Server functions call logActivity after a successful mutation. Failures
// are swallowed with a console warning: the audit trail must never break
// the operation it is describing.

import {
  impersonationMetaFor,
  sessionIdFromAuthHeader,
  type ImpersonationGrantRef,
} from "@/lib/impersonation-marker";

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

/** Best-effort staff name so every timeline entry shows WHO (spec Stage 5). */
async function actorLabelFor(supabase: any, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const { data } = await supabase
      .from("staff")
      .select("display_name")
      .eq("user_id", userId)
      .maybeSingle();
    return data?.display_name ?? null;
  } catch {
    return null;
  }
}

// Impersonation-marker lookup (H2): map the current request's auth session id
// to an active impersonation grant. Exact session-id match — no heuristics —
// cached briefly so a burst of writes in one impersonated session costs one
// indexed query. Failure-open: a lookup error just logs without the marker.
const GRANT_CACHE_TTL_MS = 60_000;
const grantCache = new Map<string, { grant: ImpersonationGrantRef | null; at: number }>();

async function activeGrantForSession(sessionId: string): Promise<ImpersonationGrantRef | null> {
  const cached = grantCache.get(sessionId);
  if (cached && Date.now() - cached.at < GRANT_CACHE_TTL_MS) return cached.grant;
  let grant: ImpersonationGrantRef | null = null;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // IMP-7: typed now that the generated types include this table's columns.
    const { data } = await supabaseAdmin
      .from("impersonation_grants")
      .select("id, actor_user_id, target_user_id")
      .eq("auth_session_id", sessionId)
      .is("ended_at", null)
      .maybeSingle();
    grant = data ?? null;
  } catch {
    grant = null;
  }
  // The cache holds one entry per active session (nulls included, so ordinary
  // sessions cost one probe per minute, not per write). Cap it hard: evict
  // expired entries first, then oldest-first if a busy org still exceeds the
  // cap — Map iteration order is insertion order, so the front is the oldest.
  if (grantCache.size >= 500) {
    for (const [k, v] of grantCache) {
      if (Date.now() - v.at >= GRANT_CACHE_TTL_MS) grantCache.delete(k);
    }
    for (const k of grantCache.keys()) {
      if (grantCache.size < 500) break;
      grantCache.delete(k);
    }
  }
  grantCache.set(sessionId, { grant, at: Date.now() });
  return grant;
}

async function impersonationMetaForRequest(
  actorUserId: string | null | undefined,
): Promise<{ grant_id: string; admin_user_id: string } | null> {
  if (!actorUserId) return null;
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const sessionId = sessionIdFromAuthHeader(getRequest()?.headers?.get("authorization"));
    if (!sessionId) return null;
    const grant = await activeGrantForSession(sessionId);
    return impersonationMetaFor(actorUserId, grant);
  } catch {
    // System writers (webhooks, nightly jobs) run outside a request — no marker.
    return null;
  }
}

export async function logActivity(supabase: any, entry: ActivityEntry): Promise<void> {
  const label = entry.actorLabel ?? (await actorLabelFor(supabase, entry.actorUserId));
  const impersonation = await impersonationMetaForRequest(entry.actorUserId);
  const meta = impersonation ? { ...(entry.meta ?? {}), impersonation } : (entry.meta ?? {});
  const { error } = await supabase.from("activity_log").insert({
    organization_id: entry.orgId,
    client_id: entry.clientId ?? null,
    property_id: entry.propertyId ?? null,
    subscription_id: entry.subscriptionId ?? null,
    actor_user_id: entry.actorUserId ?? null,
    actor_label: label,
    kind: entry.kind,
    summary: entry.summary.slice(0, 500),
    meta,
  });
  if (error) console.warn("activity_log insert failed:", error.message);
}
