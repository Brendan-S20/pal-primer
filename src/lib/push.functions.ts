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

    // Not an upsert — see savePushSubscription for why one cannot work here.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { savePushSubscription } = await import("@/lib/push.server");
    await savePushSubscription(
      supabaseAdmin,
      { column: "endpoint", value: data.endpoint },
      {
        user_id: userId,
        client_id: null,
        organization_id: orgId,
        p256dh: data.p256dh,
        auth: data.auth,
        user_agent: data.userAgent ?? null,
      },
    );
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
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    await requirePortalSession(data.token);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: client, error: cErr } = await supabaseAdmin
      .from("clients")
      .select("id, organization_id")
      .eq("portal_token", data.token)
      .maybeSingle();
    if (cErr) throw new Error(cErr.message);
    if (!client) throw new Error("Invalid portal link");

    const { savePushSubscription } = await import("@/lib/push.server");
    await savePushSubscription(
      supabaseAdmin,
      { column: "endpoint", value: data.endpoint },
      {
        client_id: client.id,
        user_id: null,
        organization_id: client.organization_id,
        p256dh: data.p256dh,
        auth: data.auth,
        user_agent: data.userAgent ?? null,
      },
    );
    return { ok: true };
  });

export const unsubscribeClientPush = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), endpoint: z.string().url() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await import("@/lib/portal-auth.server");
    await requirePortalSession(data.token);
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
    // Not an upsert: `onConflict: "native_token"` named a PARTIAL unique index
    // and failed on every call, so no device token was ever stored. See
    // savePushSubscription in push.server.ts.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { savePushSubscription } = await import("@/lib/push.server");
    await savePushSubscription(
      supabaseAdmin,
      { column: "native_token", value: data.token },
      {
        user_id: userId,
        client_id: null,
        organization_id: orgId,
        platform: data.platform,
        user_agent: data.userAgent ?? null,
      },
    );
    return { ok: true };
  });

/** Sign-out: this device stops receiving this user's notifications. Scoped to
 *  the caller's own rows by RLS and by the filter, so it can only ever release
 *  a token the caller holds. */
export const unsubscribeStaffNativePush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ token: z.string().min(10) }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { error } = await supabase
      .from("push_subscriptions")
      .delete()
      .eq("user_id", userId)
      .eq("native_token", data.token);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── "Send me a test notification" ──────────────────────────────────────────

/** One test per person per this long. In memory, per server instance, which
 *  is all it needs to be: it stops a thumb on the button from queueing a
 *  dozen pushes, not a determined caller, who can only ever reach their own
 *  phone anyway. */
export const TEST_PUSH_INTERVAL_MS = 30_000;
const lastTestPushAt = new Map<string, number>();

/** For tests. */
export function resetTestPushLimitForTests() {
  lastTestPushAt.clear();
}

/**
 * Send a test notification to the CALLER's own devices, and say how many
 * it reached. For the "Notifications on this phone" card in Settings →
 * Preferences, so a person who just turned notifications on can see one
 * arrive, and so "0 devices" says the token never reached the server.
 *
 * The recipient is `context.userId` and nothing else. There is no user,
 * device or org in the input to change; the only thing a caller chooses is
 * the wording, which arrives already translated into the language their
 * phone reads, and which only they will ever see.
 */
export const sendMyselfTestPush = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        title: z.string().trim().min(1).max(80),
        body: z.string().trim().min(1).max(200),
      })
      .strict()
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { userId } = context;
    const now = Date.now();
    const last = lastTestPushAt.get(userId);
    if (last !== undefined && now - last < TEST_PUSH_INTERVAL_MS) {
      return {
        ok: false as const,
        reason: "too_soon" as const,
        retryAfterSeconds: Math.ceil((TEST_PUSH_INTERVAL_MS - (now - last)) / 1000),
      };
    }
    lastTestPushAt.set(userId, now);
    const { sendPushToUser } = await import("@/lib/push.server");
    const { sent, failed } = await sendPushToUser(userId, {
      title: data.title,
      body: data.body,
      tag: "test-notification",
      url: "/settings/preferences",
    });
    return { ok: true as const, sent, failed };
  });
