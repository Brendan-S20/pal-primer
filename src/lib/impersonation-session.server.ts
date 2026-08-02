// BUG-2: bound the lifetime of an impersonated SESSION, server-side.
//
// consumeImpersonation mints a genuine Supabase session for the target user,
// and the impersonation tab refreshes it like any other session. Nothing used
// to stop that: `expires_at` bounds only the single-use grant token, so a tab
// left open kept working — and when it eventually degraded it did so silently.
//
// The gate lives here, behind requirePermission (guardrail 10.4: hidden UI and
// client-side redirects are not authorization). Once a grant's session window
// closes, every permission-checked server function run under that session
// fails with IMPERSONATION_EXPIRED — which the client turns into an explicit
// "session ended" state instead of a degraded, half-working page.
//
// The auth middleware is code-generated and must not be hand-edited, so the
// hook point is resolveCaller() in authz.server.ts, which every sensitive
// server function already funnels through.

import { sessionIdFromAuthHeader } from "@/lib/impersonation-marker";
import {
  IMPERSONATION_EXPIRED,
  isSessionWindowOpen,
  type GrantWindow,
} from "@/lib/impersonation-session.shared";

export {
  IMPERSONATION_EXPIRED,
  IMPERSONATION_SESSION_TTL_MS,
  isSessionWindowOpen,
} from "@/lib/impersonation-session.shared";

export class ImpersonationExpiredError extends Error {
  readonly code = IMPERSONATION_EXPIRED;
  constructor() {
    super(`${IMPERSONATION_EXPIRED}: This impersonation session has ended.`);
    this.name = "ImpersonationExpiredError";
  }
}

// One probe per session per minute rather than per permission check. Mirrors
// the cache in activity.server.ts. Expiry is evaluated against the cached
// window on every call, so a cache hit still expires the session on time — the
// cache holds the deadline, not the verdict.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { at: number; grant: GrantWindow | null }>();

/** Test seam. */
export function __clearImpersonationSessionCache() {
  cache.clear();
}

async function grantForSession(sessionId: string): Promise<GrantWindow | null> {
  const hit = cache.get(sessionId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.grant;

  let grant: GrantWindow | null = null;
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    // IMP-7: `session_expires_at` and `consumed_at` are in the generated types
    // now, so the structural cast that stood in for them is gone. The columns
    // this gate reads are checked by the compiler again — which matters here
    // more than most places, since a typo would silently stop expiring
    // impersonated sessions.
    const { data } = await supabaseAdmin
      .from("impersonation_grants")
      .select("session_expires_at, consumed_at")
      .eq("auth_session_id", sessionId)
      .is("ended_at", null)
      .maybeSingle();
    grant = (data as GrantWindow | null) ?? null;
  } catch {
    // A lookup failure must not lock ordinary users out of the product. An
    // impersonated session that can't be read is indistinguishable here from
    // an ordinary one, and ordinary sessions are the overwhelming majority.
    grant = null;
  }

  if (cache.size >= CACHE_MAX) {
    for (const [k, v] of cache) {
      if (Date.now() - v.at >= CACHE_TTL_MS) cache.delete(k);
    }
    for (const k of cache.keys()) {
      if (cache.size < CACHE_MAX) break;
      cache.delete(k);
    }
  }
  cache.set(sessionId, { at: Date.now(), grant });
  return grant;
}

/**
 * Throws ImpersonationExpiredError when the CURRENT request runs under an
 * impersonated session whose window has closed. A no-op for ordinary sessions
 * (no matching grant) and for system callers outside a request context.
 */
export async function assertImpersonationSessionActive(): Promise<void> {
  let sessionId: string | null = null;
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    sessionId = sessionIdFromAuthHeader(getRequest()?.headers?.get("authorization"));
  } catch {
    // Webhooks and nightly jobs run outside a request — nothing to bound.
    return;
  }
  if (!sessionId) return;

  const grant = await grantForSession(sessionId);
  if (!grant) return; // not an impersonated session
  if (!isSessionWindowOpen(grant, Date.now())) throw new ImpersonationExpiredError();
}
