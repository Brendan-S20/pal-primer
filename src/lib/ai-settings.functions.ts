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
    // Still permission-gated: this reports on the org's paid service, so it
    // belongs behind manage_settings like the rest of the settings surface.
    await requirePermission(context.supabase, context.userId, "manage_settings");
    return {
      /** Whether the PLATFORM can serve AI at all. False is an operator
       *  problem, never something a tenant can fix. */
      available: !!process.env.ANTHROPIC_API_KEY,
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
    const config = await resolveOrgAiConfig(orgId);
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
