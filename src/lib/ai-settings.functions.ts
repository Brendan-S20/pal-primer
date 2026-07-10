import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { DEFAULT_MODELS } from "@/lib/ai.server";

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
      .select("provider, model, api_key, updated_at")
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
    const key: string = data.api_key ?? "";
    return {
      configured: true,
      provider: data.provider as string,
      model: (data.model as string) || DEFAULT_MODELS[data.provider as "anthropic" | "openai"],
      keyLast4: key.length >= 4 ? key.slice(-4) : null,
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
        api_key: data.apiKey,
        model: data.model || DEFAULT_MODELS[data.provider],
        updated_by: context.userId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "organization_id" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
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
