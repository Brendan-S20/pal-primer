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
  // access rather than metering.
  //
  // NOT the only gate: digest.server.ts and ai-receptionist.server.ts reach the
  // gateway directly and check ai-access.server.ts themselves.
  //
  // THROWS rather than returning null when the plan is the reason, because the
  // two causes need different words and null erased the difference. Returning
  // null sent every caller into requireConfig's "Add your Anthropic or OpenAI
  // API key in Settings → AI" — a field IMP-9 deleted when BYOK was removed. So
  // a trial org clicking an AI tool was told to go and fill in something that
  // does not exist, for a reason that was never about a key.
  //
  // null still means what it always meant: the DEPLOYMENT has no key. That is
  // our problem, not the tenant's, and it keeps the wording it had.
  const { clearAiCall } = await import("@/lib/ai-access.server");
  const { allowed, reason } = await clearAiCall(_orgId);
  if (!allowed) throw new Error(reason ?? "AI features need a paid plan.");
  return resolveAiConfigFromEnv();
}

/**
 * BUILD-2: resolve the config AND the metering context in one step.
 *
 * The two have to be resolved together or they disagree. `clearAiCall` is the
 * read that decides whether this call is inside the allowance; recording that
 * verdict on the usage row is what makes an overage line on an invoice
 * traceable back to the individual calls that caused it. Resolving them
 * separately means a second read, a different answer, and a bill nobody can
 * reconcile.
 *
 * Every tenant-facing AI call site uses this. `resolveOrgAiConfig` remains for
 * the one caller that genuinely has nothing to meter — the Settings health
 * check, which spends 32 tokens proving our own configuration works.
 */
export async function resolveOrgAiCall(
  orgId: string,
  feature: import("@/lib/ai-usage").AiFeature,
): Promise<{ config: AiConfig | null; meter: import("@/lib/ai.server").AiMeter }> {
  const { clearAiCall } = await import("@/lib/ai-access.server");
  const { allowed, reason, overAllowance } = await clearAiCall(orgId);
  if (!allowed) throw new Error(reason ?? "AI features need a paid plan.");
  return {
    config: resolveAiConfigFromEnv(),
    meter: { orgId, feature, overAllowance },
  };
}
