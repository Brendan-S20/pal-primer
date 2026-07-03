import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const subSchema = z.object({
  endpoint: z.string().url(),
  p256dh: z.string().min(1),
  auth: z.string().min(1),
  userAgent: z.string().optional(),
});

// Public: expose VAPID public key so authed staff and portal clients can subscribe.
export const getPushPublicKey = createServerFn({ method: "GET" }).handler(async () => {
  return { publicKey: process.env.VAPID_PUBLIC_KEY ?? null };
});

export const subscribeStaffPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => subSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    const orgId = role?.organization_id ?? null;

    const { error } = await supabase
      .from("push_subscriptions")
      .upsert(
        {
          user_id: userId,
          organization_id: orgId,
          endpoint: data.endpoint,
          p256dh: data.p256dh,
          auth: data.auth,
          user_agent: data.userAgent ?? null,
          disabled: false,
          last_error: null,
        },
        { onConflict: "endpoint" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unsubscribeStaffPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ endpoint: z.string().url() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .eq("endpoint", data.endpoint);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

const portalSubSchema = subSchema.extend({ token: z.string().uuid() });

export const subscribeClientPush = createServerFn({ method: "POST" })
  .inputValidator((d) => portalSubSchema.parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: client, error: cErr } = await supabaseAdmin
      .from("clients")
      .select("id, organization_id")
      .eq("portal_token", data.token)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!client) throw new Error("Invalid portal link");

    const { error } = await supabaseAdmin
      .from("push_subscriptions")
      .upsert(
        {
          client_id: client.id,
          organization_id: client.organization_id,
          endpoint: data.endpoint,
          p256dh: data.p256dh,
          auth: data.auth,
          user_agent: data.userAgent ?? null,
          disabled: false,
          last_error: null,
        },
        { onConflict: "endpoint" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unsubscribeClientPush = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), endpoint: z.string().url() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("id")
      .eq("portal_token", data.token)
      .maybeSingle();
    if (!client) return { ok: true };
    await supabaseAdmin
      .from("push_subscriptions")
      .delete()
      .eq("client_id", client.id)
      .eq("endpoint", data.endpoint);
    return { ok: true };
  });

// ── Native (APNs/FCM) push token registration ──────────────────────────────

const nativeSchema = z.object({
  token: z.string().min(10),
  platform: z.enum(["ios", "android"]),
  userAgent: z.string().optional(),
});

export const subscribeStaffNativePush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => nativeSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    const orgId = role?.organization_id ?? null;
    const { error } = await supabase.from("push_subscriptions").upsert(
      {
        user_id: userId,
        organization_id: orgId,
        native_token: data.token,
        platform: data.platform,
        user_agent: data.userAgent ?? null,
        disabled: false,
        last_error: null,
      },
      { onConflict: "native_token" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const subscribeClientNativePush = createServerFn({ method: "POST" })
  .inputValidator((d) => nativeSchema.extend({ token: z.string().min(10), portalToken: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: client, error: cErr } = await supabaseAdmin
      .from("clients")
      .select("id, organization_id")
      .eq("portal_token", data.portalToken)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!client) throw new Error("Invalid portal link");
    const { error } = await supabaseAdmin.from("push_subscriptions").upsert(
      {
        client_id: client.id,
        organization_id: client.organization_id,
        native_token: data.token,
        platform: data.platform,
        user_agent: data.userAgent ?? null,
        disabled: false,
        last_error: null,
      },
      { onConflict: "native_token" },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });
