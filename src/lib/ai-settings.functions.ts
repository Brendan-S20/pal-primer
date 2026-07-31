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
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "manage_settings",
    );
    const { checkAiAccess } = await import("@/lib/ai-access.server");
    const { allowed: planAllowsAi, reason: planReason } = await checkAiAccess(orgId);

    return {
      planAllowsAi,
      planReason,
      toolsAvailable: !!process.env.ANTHROPIC_API_KEY,
      assistantAvailable: !!process.env.LOVABLE_API_KEY,
      model: DEFAULT_MODELS.anthropic,
      /** Usage, allowance, and overage reporting arrive with BUILD-2. Saying so
       *  explicitly beats rendering a zero that looks like a real measurement. */
      meteringAvailable: false,
    };
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
        jsonSchema: { type: "object", properties: { status: { type: "string" } }, required: ["status"] },
        maxTokens: 32,
      });
      return { ok: true as const, provider: config.provider, model: config.model };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  });
