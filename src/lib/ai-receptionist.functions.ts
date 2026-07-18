import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { z } from "zod";

// The AI receptionist config (persona, FAQ, voice, enable) is a customer-facing
// org setting written via supabaseAdmin (the columns are platform-protected, so
// the write bypasses the owner-only RLS). That makes the app-layer permission
// check the ONLY gate — enforce manage_settings (owner + office_manager) on
// read and write, matching the sibling settings fns (I7). Without it any member
// (tech/dispatcher) could rewrite or disable the receptionist script via the API.
async function orgIdFor(supabase: any, userId: string) {
  return (await requirePermission(supabase, userId, "manage_settings")).orgId;
}

export const getAiReceptionistSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await orgIdFor(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("organizations")
      .select(
        "ai_receptionist_enabled, ai_receptionist_faq, ai_receptionist_persona, ai_voice_enabled, ai_voice_greeting",
      )
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    return data;
  });

export const updateAiReceptionistSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        enabled: z.boolean(),
        faq: z.string().max(20000).nullable(),
        persona: z.string().max(4000).nullable(),
        voice_enabled: z.boolean().optional(),
        voice_greeting: z.string().max(1000).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await orgIdFor(context.supabase, context.userId);

    // The AI Receptionist is a paid plan add-on: enabling it here requires an
    // active add-on subscription (QA finding: the old free toggle let any
    // owner switch on the $49/mo feature). Turning it OFF, and editing the
    // FAQ/persona, stay unrestricted.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    if (data.enabled) {
      const { data: sub } = await (supabaseAdmin as any)
        .from("org_platform_addons")
        .select("status, platform_addons!inner(slug)")
        .eq("organization_id", orgId)
        .eq("status", "active")
        .eq("platform_addons.slug", "ai-receptionist")
        .maybeSingle();
      if (!sub) {
        throw new Error(
          "The AI Receptionist is a plan add-on. Add it in Settings -> Billing first, then enable it here.",
        );
      }
    }

    const patch: {
      ai_receptionist_enabled: boolean;
      ai_receptionist_faq: string | null;
      ai_receptionist_persona: string | null;
      ai_voice_enabled?: boolean;
      ai_voice_greeting?: string | null;
    } = {
      ai_receptionist_enabled: data.enabled,
      ai_receptionist_faq: data.faq,
      ai_receptionist_persona: data.persona,
    };
    if (data.voice_enabled !== undefined) patch.ai_voice_enabled = data.voice_enabled;
    if (data.voice_greeting !== undefined) patch.ai_voice_greeting = data.voice_greeting;
    // ai_receptionist_enabled is a platform-protected column now; the write
    // must come from the service role (we've done the authz above).
    const { error } = await (supabaseAdmin as any)
      .from("organizations")
      .update(patch)
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const listAiReceptionistLogs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const orgId = await orgIdFor(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("ai_receptionist_logs")
      .select("id, created_at, from_number, user_text, reply_text, escalated, latency_ms, error, tool_calls, channel, call_sid, turn")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { logs: data ?? [] };
  });
