import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { DEFAULT_MODELS } from "@/lib/ai.server";
import { encryptSecret, secretLast4, isEncrypted } from "@/lib/secret-encryption.server";

// BYOK settings: the owner enters their own Anthropic/OpenAI key. Reads/writes
// go through the service-role client so the key is never exposed to RLS/browser;
// the status endpoint only ever returns a masked last-4, never the raw key.

export const getOrgAiSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await (supabaseAdmin as any)
      .from("org_ai_credentials")
      .select("provider, model, api_key, key_last4, updated_at")
      .eq("organization_id", orgId)
      .maybeSingle();
    const hasPlatformFallback = !!process.env.ANTHROPIC_API_KEY;
    if (!data) {
      return {
        configured: false,
        provider: null as string | null,
        model: null as string | null,
        keyLast4: null as string | null,
        usingPlatformFallback: hasPlatformFallback,
        defaultModels: DEFAULT_MODELS,
      };
    }
    // IMP-1: the hint is read from its own column rather than derived from the
    // stored value, which is now ciphertext. Falls back to deriving it for any
    // row written before the change (there were none, but the fallback costs
    // nothing and makes the transition safe in either direction).
    const stored: string = data.api_key ?? "";
    const last4 =
      (data.key_last4 as string | null) ??
      (!isEncrypted(stored) && stored.length >= 4 ? stored.slice(-4) : null);
    return {
      configured: true,
      provider: data.provider as string,
      model: (data.model as string) || DEFAULT_MODELS[data.provider as "anthropic" | "openai"],
      keyLast4: last4,
      usingPlatformFallback: false,
      defaultModels: DEFAULT_MODELS,
    };
  });

export const setOrgAiSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        provider: z.enum(["anthropic", "openai"]),
        apiKey: z.string().trim().min(10).max(300),
        model: z.string().trim().max(100).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any).from("org_ai_credentials").upsert(
      {
        organization_id: orgId,
        provider: data.provider,
        // IMP-1: ciphertext, never the raw key. encryptSecret throws when
        // CREDENTIAL_ENCRYPTION_KEY is unset, so a misconfigured environment
        // fails the save loudly instead of quietly writing plaintext.
        api_key: encryptSecret(data.apiKey),
        // Non-secret display hint, captured here so rendering the settings page
        // never has to decrypt anything.
        key_last4: secretLast4(data.apiKey),
        model: data.model || DEFAULT_MODELS[data.provider],
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Health check: run a tiny structured call against the org's AI key so a
 *  revoked/invalid key surfaces here instead of failing silently in a tool. */
export const testOrgAiKey = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { resolveOrgAiConfig } = await import("@/lib/ai-credentials.server");
    const config = await resolveOrgAiConfig(orgId);
    if (!config) return { ok: false as const, error: "No AI key configured yet." };
    const { generateStructured } = await import("@/lib/ai.server");
    try {
      await generateStructured({
        config,
        label: "Key health check",
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

export const clearOrgAiSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await (supabaseAdmin as any)
      .from("org_ai_credentials")
      .delete()
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
