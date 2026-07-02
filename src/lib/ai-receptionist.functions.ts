import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function orgIdFor(supabase: any, userId: string) {
  const { data } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (!data) throw new Error("No organization");
  return data.organization_id as string;
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
    const patch: Record<string, unknown> = {
      ai_receptionist_enabled: data.enabled,
      ai_receptionist_faq: data.faq,
      ai_receptionist_persona: data.persona,
    };
    if (data.voice_enabled !== undefined) patch.ai_voice_enabled = data.voice_enabled;
    if (data.voice_greeting !== undefined) patch.ai_voice_greeting = data.voice_greeting;
    const { error } = await context.supabase
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
      .select("id, created_at, from_number, user_text, reply_text, escalated, latency_ms, error, tool_calls")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { logs: data ?? [] };
  });
