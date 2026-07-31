// BUILD-7 — the one gate on whether an organization may use AI.
//
// Owner decision: AI is paid-only. It runs on HoundStack's own keys and there
// is no usage metering yet (BUILD-2, blocked on Stripe), so a trial with AI is
// unbounded spend on our account with nothing in place to notice it.
//
// ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
//
// There are THREE ways into the model, and only one of them goes through
// `resolveOrgAiConfig`:
//
//   ai-tools.functions.ts / ai-settings  → resolveOrgAiConfig()
//   digest.server.ts                     → createLovableAiGatewayProvider() direct
//   ai-receptionist.server.ts            → createLovableAiGatewayProvider() direct
//
// Gating only the resolver would leave two doors open, and the two it leaves
// open are the unattended ones — the weekly digest fires from cron and the
// receptionist answers inbound texts, so neither has a human to notice the bill.
// That is the same shape as BUG-21 and IMP-10: one rule, several
// implementations, and the one nobody updated is the one that costs money.
//
// So the rule lives here and all three call it.
//
// ── CACHING ────────────────────────────────────────────────────────────────
//
// 60 seconds, matching entitlements.server.ts. An org that pays should get AI
// within a minute without a deploy; an org whose trial lapses keeps it for at
// most a minute, which is a rounding error against a monthly bill.

import { aiAvailableFor, aiUnavailableReason, trialStateFor } from "@/lib/trial";

type CacheEntry = { allowed: boolean; reason: string | null; at: number };
const CACHE = new Map<string, CacheEntry>();
const TTL_MS = 60_000;

/** Drop a cached decision — call after a plan change so the next request sees it. */
export function invalidateAiAccess(orgId: string) {
  CACHE.delete(orgId);
}

export type AiAccess = { allowed: boolean; reason: string | null };

/**
 * May this organization call the model?
 *
 * Fails CLOSED on a lookup error, unlike PlanGate which fails open. The
 * asymmetry is deliberate: showing a feature to someone who has not paid costs
 * nothing, whereas calling the model does, and an outage that silently grants
 * unlimited AI to every trial is exactly the failure this gate exists to
 * prevent.
 */
export async function checkAiAccess(orgId: string): Promise<AiAccess> {
  const hit = CACHE.get(orgId);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return { allowed: hit.allowed, reason: hit.reason };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (supabaseAdmin as any)
    .from("organizations")
    .select("plan_status, billing_status, trial_ends_at, stripe_subscription_id")
    .eq("id", orgId)
    .maybeSingle();

  if (error || !data) {
    // Not cached: a transient failure must not lock an org out for a minute,
    // and must not be the thing that lets one in either.
    return {
      allowed: false,
      reason: "We couldn't confirm your plan just now, so AI is paused. Try again in a moment.",
    };
  }

  const state = trialStateFor({
    planStatus: data.plan_status,
    billingStatus: data.billing_status,
    trialEndsAt: data.trial_ends_at,
    hasSubscription: !!data.stripe_subscription_id,
  });
  const allowed = aiAvailableFor(state);
  const reason = aiUnavailableReason(state);

  CACHE.set(orgId, { allowed, reason, at: Date.now() });
  return { allowed, reason };
}

/** Throwing form, for call sites that surface an error to a person. */
export async function requireAiAccess(orgId: string): Promise<void> {
  const { allowed, reason } = await checkAiAccess(orgId);
  if (!allowed) throw new Error(reason ?? "AI features need a paid plan.");
}

/** Boolean form, for unattended jobs that must skip quietly rather than throw
 *  — a cron that raises on every trial org would bury its real errors. */
export async function orgMayUseAi(orgId: string): Promise<boolean> {
  return (await checkAiAccess(orgId)).allowed;
}
