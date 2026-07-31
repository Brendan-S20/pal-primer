// AI inference runs on HOUNDSTACK's key. Always.
//
// IMP-9 / BYOK retirement (owner decision, 2026-07-29): this used to read a
// per-org key out of org_ai_credentials and fall back to the platform key only
// when an org had none. No org ever set one, so the fallback was the only path
// that ever ran — the BYO branch was dead code that nonetheless made the
// product ASK customers for a key it never needed.
//
// Tenants buy an AI allowance and pay overages (Q-7). Metering is BUILD-2 and is
// not built yet, so inference on the platform key is currently uncapped. That
// was already true before this change — every org was on the platform key — so
// nothing got riskier here, it got honest. BUILD-2 is now the only thing between
// us and unmetered spend, which is worth knowing when prioritizing it.

import { resolveAiConfigFromEnv, type AiConfig } from "@/lib/ai.server";

/**
 * The AI config for an org: the platform's, because that is the only kind there
 * is now.
 *
 * Returns null when the platform key itself is unset. That is a deployment
 * problem rather than a tenant one, and callers surface it as "AI is
 * unavailable" — never as "add your key".
 *
 * `orgId` is kept in the signature deliberately. BUILD-2 needs a per-org hook
 * exactly here to attribute usage and enforce the allowance; threading it back
 * through every call site later would be pure churn.
 */
export async function resolveOrgAiConfig(_orgId: string): Promise<AiConfig | null> {
  // BUILD-7: the per-org hook this signature was reserved for, used first for
  // access rather than metering. Returns null when the org may not use AI, and
  // callers already treat null as "AI is unavailable" — so no call site needed
  // to change to respect a paid-only policy.
  //
  // NOT the only gate: digest.server.ts and ai-receptionist.server.ts reach the
  // gateway directly and check ai-access.server.ts themselves.
  const { orgMayUseAi } = await import("@/lib/ai-access.server");
  if (!(await orgMayUseAi(_orgId))) return null;
  return resolveAiConfigFromEnv();
}
