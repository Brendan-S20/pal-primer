// BUILD-2 — the metering side effects: read where an org stands, refuse when it
// is past its ceiling, and record what a call cost.
//
// ── WHY THIS IS SEPARATE FROM ai-access.server.ts ─────────────────────────
//
// That module answers "may this org use AI at all" — a plan question, cached
// for 60 seconds. This one answers "may this org use AI RIGHT NOW", which
// changes with every call and therefore cannot be cached at all. Folding the
// budget into the cached decision would let an org run 60 seconds past its
// ceiling on every check, and 60 seconds of an automated loop is exactly the
// spend this exists to stop.
//
// The two compose in ai-access.server.ts so all three doors into the model get
// both, which is the property that module was built to guarantee.

import {
  decideAiCall,
  estimateCostMicros,
  isBillableFeature,
  shouldWarn,
  type AiFeature,
  type AiUsageState,
} from "@/lib/ai-usage";

/** Read the org's position from the one SQL definition of it. */
export async function readAiUsageState(orgId: string): Promise<AiUsageState | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await (
    supabaseAdmin as never as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: unknown }>;
    }
  ).rpc("ai_usage_state", { _org_id: orgId });
  if (error) {
    console.error("[ai-usage] state read failed", orgId, error);
    return null;
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    periodMonth: String(row.period_month ?? ""),
    actionsUsed: Number(row.actions_used ?? 0),
    actionsIncluded: row.actions_included == null ? null : Number(row.actions_included),
    overageCentsPerAction:
      row.overage_cents_per_action == null ? null : Number(row.overage_cents_per_action),
    hardCapActions: row.hard_cap_actions == null ? null : Number(row.hard_cap_actions),
    overAllowance: !!row.over_allowance,
    overHardCap: !!row.over_hard_cap,
    overageCents: Number(row.overage_cents ?? 0),
  };
}

/** The org's current ceiling multiplier. Separate from `ai_usage_state`
 *  because that function returns the ceiling already applied — Settings needs
 *  the raw setting to put in the input. */
export async function organizationsHardCapMultiplier(orgId: string): Promise<number> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await (
    supabaseAdmin as never as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> };
        };
      };
    }
  )
    .from("organizations")
    .select("ai_hard_cap_multiplier")
    .eq("id", orgId)
    .maybeSingle();
  const v = (data as { ai_hard_cap_multiplier?: number | string | null } | null)
    ?.ai_hard_cap_multiplier;
  return v == null ? 3 : Number(v);
}

export type AiBudget = { allowed: boolean; reason: string | null; overAllowance: boolean };

/**
 * Is this org within its AI budget?
 *
 * Fails OPEN, deliberately, and it is the one place in this feature that does.
 * `checkAiAccess` fails closed because a lookup error there could grant AI to
 * someone who has not paid. Here the org has already been found eligible, and
 * refusing a paying customer's AI because a counter did not load turns our
 * outage into their outage. The call is still recorded when it completes, so a
 * transient read failure loses the ceiling for one call, not the meter.
 */
export async function checkAiBudget(orgId: string): Promise<AiBudget> {
  const state = await readAiUsageState(orgId);
  if (!state) return { allowed: true, reason: null, overAllowance: false };

  const decision = decideAiCall(state);
  if (!decision.allow) return { allowed: false, reason: decision.reason, overAllowance: true };

  // Crossing 80% files one review-queue item, not one per call after it.
  if (shouldWarn(state, false)) void warnOnceIfNeeded(orgId, state).catch(() => {});

  return { allowed: true, reason: null, overAllowance: decision.overAllowance };
}

/**
 * File the 80% warning at most once per org per month.
 *
 * TWO independent guards, because this is a notification and the failure mode
 * is sending it on every AI call for the rest of the month:
 *
 *   1. `ai_usage_periods.warned_at` is claimed by a conditional update, so of
 *      two calls crossing 80% at the same moment only one proceeds;
 *   2. `review_items` is unique on (org, kind, subject, occurrence-key), with
 *      the month as the occurrence key — so even if the claim were lost the
 *      database still refuses the duplicate.
 *
 * The second is not belt-and-braces for its own sake: the claim lives in a row
 * the rollup trigger also rewrites, and a constraint that does not depend on
 * anything going right is the only kind worth relying on for money.
 */
async function warnOnceIfNeeded(orgId: string, state: AiUsageState): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const admin = supabaseAdmin as never as {
    from: (t: string) => {
      update: (p: Record<string, unknown>) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          eq: (
            k: string,
            v: unknown,
          ) => {
            is: (
              k: string,
              v: null,
            ) => {
              select: (c: string) => Promise<{ data: unknown[] | null }>;
            };
          };
        };
      };
      insert: (p: Record<string, unknown>) => Promise<{ error: unknown }>;
    };
  };

  const { data: claimed } = await admin
    .from("ai_usage_periods")
    .update({ warned_at: new Date().toISOString() })
    .eq("organization_id", orgId)
    .eq("period_month", state.periodMonth)
    .is("warned_at", null)
    .select("organization_id");
  if (!claimed || claimed.length === 0) return;

  const used = state.actionsUsed.toLocaleString();
  const included = (state.actionsIncluded ?? 0).toLocaleString();
  const rate = state.overageCentsPerAction;
  const after = rate ? ` Past that, actions are $${(rate / 100).toFixed(2)} each.` : "";
  await admin.from("review_items").insert({
    organization_id: orgId,
    kind: "ai_allowance_warning",
    subject_table: "organizations",
    subject_id: orgId,
    // <= 500 chars: review_items_reason_check.
    reason:
      `AI usage is at ${used} of the ${included} actions included this month.${after} ` +
      `Nothing is paused. AI only stops at the ceiling, which you set in Settings → AI usage.`,
    detail: {
      actions_used: state.actionsUsed,
      actions_included: state.actionsIncluded,
      period_month: state.periodMonth,
    },
    // The occurrence key — see the column comment. The month, so next month
    // can warn again and this month cannot warn twice.
    dispute_ref: state.periodMonth,
  });
}

/**
 * Record one AI invocation.
 *
 * NEVER THROWS. A metering failure must not fail the feature it meters — the
 * model call already happened and the money is already spent, so throwing here
 * would lose the customer's result AND the record of the cost, which is the
 * worst of both. Failures are logged loudly instead.
 *
 * Called AFTER the provider responds, so a failed call (a 500, a timeout)
 * spends nothing and is not billed. That is the customer-favourable reading of
 * an ambiguous case, and it is also the honest one: we were not able to do the
 * thing they asked for.
 */
export async function recordAiUsage(opts: {
  orgId: string;
  feature: AiFeature;
  provider: string;
  model?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  /** From checkAiBudget, so the row records whether this call was over. */
  overAllowance?: boolean;
}): Promise<void> {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const admin = supabaseAdmin as never as {
      from: (t: string) => {
        select: (c: string) => {
          eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> };
        };
        insert: (p: Record<string, unknown>) => Promise<{ error: unknown }>;
      };
    };

    // The org's OWN month, so a 9pm call on the 31st is not next month's usage.
    const { data: org } = await admin
      .from("organizations")
      .select("timezone")
      .eq("id", opts.orgId)
      .maybeSingle();
    const { orgToday, DEFAULT_ORG_TIMEZONE } = await import("@/lib/org-day");
    const tz = (org as { timezone?: string | null } | null)?.timezone || DEFAULT_ORG_TIMEZONE;
    const periodMonth = `${orgToday(tz).slice(0, 7)}-01`;

    const inputTokens = Math.max(0, Math.round(opts.inputTokens ?? 0));
    const outputTokens = Math.max(0, Math.round(opts.outputTokens ?? 0));

    const { error } = await admin.from("ai_usage_events").insert({
      organization_id: opts.orgId,
      period_month: periodMonth,
      feature: opts.feature,
      provider: opts.provider,
      model: opts.model ?? null,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_micros: estimateCostMicros({ model: opts.model, inputTokens, outputTokens }),
      // An unbilled feature still gets a row — see UNBILLED_FEATURES — it just
      // does not consume the allowance.
      actions: isBillableFeature(opts.feature) ? 1 : 0,
      over_allowance: !!opts.overAllowance,
    });
    if (error) console.error("[ai-usage] record failed", opts.orgId, opts.feature, error);
  } catch (e) {
    console.error("[ai-usage] record threw", opts.orgId, opts.feature, e);
  }
}
