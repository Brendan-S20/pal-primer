import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { DEFAULT_MODELS } from "@/lib/ai.server";

// AI settings after the BYOK retirement (IMP-9).
//
// This file used to hold setOrgAiSettings / clearOrgAiSettings — a tenant-facing
// write path for their own Anthropic or OpenAI key. Both are gone, along with
// every read of org_ai_credentials. AI runs on HoundStack's key; a tenant buys
// an allowance and pays overages (Q-7).
//
// What remains is status and a health check, because "is AI working right now"
// is still a question an owner reasonably asks — the answer just no longer has
// anything to do with a key they hold.

export const getOrgAiSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    // There are TWO managed AI paths, not one, and reporting only the first
    // would have let this page say "AI is enabled" while the receptionist and
    // the weekly digest were dead:
    //
    //   tools    — Anthropic, via ANTHROPIC_API_KEY (ai.server.ts). Powers
    //              marketing content, review replies, churn scoring, AI
    //              dispatch, zone pricing.
    //   assistant— Lovable AI gateway, via LOVABLE_API_KEY
    //              (ai-gateway.server.ts). Powers the AI receptionist and the
    //              business advisor / weekly digest.
    //
    // Consolidating them is worth doing and belongs with BUILD-2's metering,
    // which has to capture usage on BOTH or it will undercount.
    // BUILD-7: availability was reported from environment variables ALONE, so
    // an organization whose plan does not include AI saw "AI is enabled for
    // this organization" and, on pressing the check, "AI is not configured on
    // this deployment" — the page blaming our infrastructure for their plan,
    // while the tools themselves refused for a third, different reason. Three
    // contradictory answers to one question.
    //
    // The two facts are reported separately because they need different words
    // and different people fix them: a missing key is ours, a plan is theirs.
    //
    // Still permission-gated: this reports on the org's paid service, so it
    // belongs behind manage_settings like the rest of the settings surface.
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { checkAiAccess } = await import("@/lib/ai-access.server");
    const { allowed: planAllowsAi, reason: planReason } = await checkAiAccess(orgId);

    return {
      planAllowsAi,
      planReason,
      toolsAvailable: !!process.env.ANTHROPIC_API_KEY,
      assistantAvailable: !!process.env.LOVABLE_API_KEY,
      model: DEFAULT_MODELS.anthropic,
      /** BUILD-2 shipped. The numbers come from getAiUsage(), which reads the
       *  same ai_usage_state the request path enforces against. */
      meteringAvailable: true,
    };
  });

/**
 * BUILD-2 — where this organization stands against its AI allowance.
 *
 * Reads `ai_usage_state`, the SAME function the request path enforces against,
 * plus the per-feature breakdown. Deriving the numbers a second way here is
 * exactly how a settings page ends up telling an owner they have allowance
 * left while the product refuses their next call.
 *
 * Gated on `manage_org_billing` rather than `manage_settings`: this is money
 * owed, and it matches the RLS on the underlying tables.
 */
export const getAiUsage = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_org_billing",
    );
    const { readAiUsageState } = await import("@/lib/ai-usage.server");
    const state = await readAiUsageState(orgId);
    if (!state) return { available: false as const };

    // What used it. The first question an owner asks about an unexpected line.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rows } = await (
      supabaseAdmin as never as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (
              k: string,
              v: unknown,
            ) => {
              eq: (k: string, v: unknown) => Promise<{ data: unknown[] | null }>;
            };
          };
        };
      }
    )
      .from("ai_usage_events")
      .select("feature, actions, input_tokens, output_tokens")
      .eq("organization_id", orgId)
      .eq("period_month", state.periodMonth);

    const byFeature = new Map<string, { actions: number; tokens: number }>();
    for (const r of (rows ?? []) as Array<Record<string, number | string>>) {
      const key = String(r.feature);
      const e = byFeature.get(key) ?? { actions: 0, tokens: 0 };
      e.actions += Number(r.actions ?? 0);
      e.tokens += Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0);
      byFeature.set(key, e);
    }

    const { organizationsHardCapMultiplier } = await import("@/lib/ai-usage.server");
    return {
      available: true as const,
      ...state,
      hardCapMultiplier: await organizationsHardCapMultiplier(orgId),
      breakdown: [...byFeature.entries()]
        .map(([feature, v]) => ({ feature, ...v }))
        .sort((a, b) => b.actions - a.actions),
    };
  });

/**
 * BUILD-2 — move the ceiling.
 *
 * The owner's control over their own exposure. Constrained to the same range
 * the CHECK constraint enforces, and refused below 1.0 in both places: a
 * ceiling under the allowance would pause AI the org has already paid for,
 * which is a worse outcome than the surprise bill it is meant to prevent.
 */
export const setAiHardCapMultiplier = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .validator(z.object({ multiplier: z.number().min(1).max(100) }))
  .handler(async ({ context, data }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_org_billing",
    );
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (
      supabaseAdmin as never as {
        from: (t: string) => {
          update: (p: Record<string, unknown>) => {
            eq: (k: string, v: unknown) => Promise<{ error: unknown }>;
          };
        };
      }
    )
      .from("organizations")
      .update({ ai_hard_cap_multiplier: data.multiplier })
      .eq("id", orgId);
    if (error) throw new Error("Could not update the AI ceiling.");
    return { ok: true as const, multiplier: data.multiplier };
  });

/** Health check: a tiny structured call on the platform key, so a revoked or
 *  misconfigured key surfaces here rather than failing inside a tool later. */
export const testOrgAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { resolveOrgAiConfig } = await import("@/lib/ai-credentials.server");
    let config;
    try {
      config = await resolveOrgAiConfig(orgId);
    } catch (e) {
      // A plan refusal, which resolveOrgAiConfig now raises with its own words.
      // This used to come back as null and get reported as "AI is not
      // configured on this deployment" — blaming our infrastructure for the
      // caller's plan, and sending them to support over something support
      // cannot change.
      return { ok: false as const, error: (e as Error).message };
    }
    if (!config) {
      // Deliberately not "add your key" — there is nothing for the tenant to do.
      return { ok: false as const, error: "AI is not configured on this deployment." };
    }
    const { generateStructured } = await import("@/lib/ai.server");
    try {
      await generateStructured({
        config,
        label: "AI health check",
        prompt: "Respond with status set to the string ok.",
        schema: z.object({ status: z.string() }),
        jsonSchema: {
          type: "object",
          properties: { status: { type: "string" } },
          required: ["status"],
        },
        maxTokens: 32,
        // BUILD-2: recorded, but with actions = 0 (UNBILLED_FEATURES). This is
        // OUR diagnostic — billing a customer's allowance for us proving our
        // own key works is indefensible — but a call that leaves no trace at
        // all is indistinguishable from a meter that missed it.
        meter: { orgId, feature: "connection_test" },
      });
      return { ok: true as const, provider: config.provider, model: config.model };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });
