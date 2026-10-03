// BUILD-7 — the one gate on whether an organization may use AI.
//
// Owner decision: AI is paid-only. It runs on HoundStack's own keys, so before
// BUILD-2 a trial with AI was unbounded spend on our account with nothing in
// place to notice it.
//
// BUILD-2 added the second half. This module now answers two questions, not
// one: MAY they (plan, cached) and CAN THEY AFFORD IT (budget, never cached).
// `clearAiCall` composes both, and `requireAiAccess` / `orgMayUseAi` — the two
// functions all three doors already called — go through it, so the ceiling
// reaches every door without any call site being asked to remember it.
//
// ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────
//
// There were THREE ways into the model, and only one of them went through
// `resolveOrgAiConfig`:
//
//   ai-tools.functions.ts / ai-settings  → resolveOrgAiConfig()
//   digest.server.ts                     → the Lovable AI gateway, direct
//   ai-receptionist.server.ts            → the Lovable AI gateway, direct
//
// (2026-10-03: the digest no longer calls a model, and the receptionist moved
// to Anthropic via @ai-sdk/anthropic, so the gateway module is gone and two
// doors remain. The rule below is unchanged, and still applies to whichever
// door is added next.)
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
    // created_at is here for enforcementApplies, which fails OPEN without it.
    // It was missing, so this call site had trial enforcement silently disabled
    // while line 85 below passed `data.created_at` — undefined — into it.
    .select("plan_status, billing_status, trial_ends_at, stripe_subscription_id, created_at")
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
    createdAt: data.created_at,
  });
  const allowed = aiAvailableFor(state);
  const reason = aiUnavailableReason(state);

  CACHE.set(orgId, { allowed, reason, at: Date.now() });
  return { allowed, reason };
}

/**
 * May this organization call the model right now?
 *
 * `checkAiAccess` answers the PLAN question and is cached for a minute.
 * BUILD-2's budget question cannot be cached — it changes with every call, and
 * a minute of an automated loop past the ceiling is the exact spend the
 * ceiling exists to prevent. So the two are separate reads, composed here.
 *
 * Order matters: the plan check runs first and is the cheap cached one, so an
 * org with no AI at all never reaches the database for a budget it cannot
 * spend.
 *
 * The returned `overAllowance` is passed through to `recordAiUsage` by callers
 * that meter, so the event row records whether that particular call was inside
 * the allowance or billable as overage.
 */
export type AiClearance = { allowed: boolean; reason: string | null; overAllowance: boolean };

export async function clearAiCall(orgId: string): Promise<AiClearance> {
  const plan = await checkAiAccess(orgId);
  if (!plan.allowed) {
    return { allowed: false, reason: plan.reason, overAllowance: false };
  }
  const { checkAiBudget } = await import("@/lib/ai-usage.server");
  return await checkAiBudget(orgId);
}

/** Throwing form, for call sites that surface an error to a person. */
export async function requireAiAccess(orgId: string): Promise<void> {
  const { allowed, reason } = await clearAiCall(orgId);
  if (!allowed) throw new Error(reason ?? "AI features need a paid plan.");
}

/** Boolean form, for unattended jobs that must skip quietly rather than throw
 *  — a cron that raises on every trial org would bury its real errors.
 *
 *  This is the form the receptionist and the digest use, which makes it the
 *  one that matters most for BUILD-2: they are the callers with no human to
 *  notice the bill, so they are the ones the ceiling has to stop. */
export async function orgMayUseAi(orgId: string): Promise<boolean> {
  return (await clearAiCall(orgId)).allowed;
}
