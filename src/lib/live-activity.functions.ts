// Saving and ending the push token of the route on a tech's lock screen, and
// minting the action token its Start button presses with.
//
// Called by My Day on the iPhone (src/components/my-day/RouteLockScreen
// .tsx) when ActivityKit hands out a token, when it rotates one, and when the
// activity ends. Written with the CALLER's client, so live_activity_tokens'
// RLS decides what is allowed: a token in the caller's own name, in an org
// the caller belongs to (20261004120000_the-route-on-the-lock-screen.sql).
// The server reads them back with the service role to push when the office
// changes that tech's day (src/lib/push-liveactivity.server.ts).

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const activityId = z.string().min(1).max(200);

export const saveLiveActivityToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        activityId,
        token: z
          .string()
          .regex(/^[0-9a-f]{16,512}$/i, "Not a push token")
          .transform((s) => s.toLowerCase()),
        routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        language: z.enum(["en", "es", "ar", "zh"]).default("en"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: staff, error: staffErr } = await supabase
      .from("staff")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (staffErr) throw new Error(staffErr.message);
    // Only somebody with a route has a route on their lock screen.
    if (!staff?.organization_id) return { saved: false };

    const now = new Date().toISOString();
    const { error } = await supabase.from("live_activity_tokens").upsert(
      {
        user_id: userId,
        organization_id: staff.organization_id,
        activity_id: data.activityId,
        push_token: data.token,
        route_date: data.routeDate,
        locale: data.language,
        updated_at: now,
        ended_at: null,
        end_reason: null,
        last_error: null,
      },
      { onConflict: "user_id,activity_id" },
    );
    if (error) throw new Error(error.message);

    // The plugin keeps one activity per phone and ends the others, so any
    // other live row of this user's is an activity that is gone. Without this
    // a phone that was replaced, or an activity iOS ended while the app was
    // closed, would be pushed to until APNs said 410.
    await supabase
      .from("live_activity_tokens")
      .update({ ended_at: now, end_reason: "superseded" })
      .eq("user_id", userId)
      .neq("activity_id", data.activityId)
      .is("ended_at", null);
    return { saved: true };
  });

/**
 * The action token for Start on the lock screen (src/lib/live-activity-action
 * .ts). Minted by the signed-in app when the route goes on the lock screen,
 * handed to the native plugin, which keeps it in the keychain for the App
 * Intent, and returned to the caller exactly once: only its SHA-256 is
 * stored. Minting a new one revokes every other the caller holds, so a phone
 * has one live token at a time and a replaced phone's stops working.
 *
 * Only for the caller's own active staff record, and only for the org's
 * today: a token for another day would start nothing, and minting one is a
 * sign something is wrong.
 */
export const mintLiveActivityActionToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        routeDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        language: z.enum(["en", "es", "ar", "zh"]).default("en"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Read with the CALLER's client: RLS decides whose staff row this is.
    const { data: staff, error: staffErr } = await supabase
      .from("staff")
      .select("id, organization_id, active")
      .eq("user_id", userId)
      .eq("active", true)
      .maybeSingle();
    if (staffErr) throw new Error(staffErr.message);
    if (!staff?.organization_id) return { minted: false as const };

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const db = supabaseAdmin as unknown as { from: (t: string) => any };
    const { data: org } = await db
      .from("organizations")
      .select("timezone, workday_end")
      .eq("id", staff.organization_id)
      .maybeSingle();
    const { DEFAULT_ORG_TIMEZONE, orgToday } = await import("@/lib/org-day");
    const tz = (org?.timezone as string | null) || DEFAULT_ORG_TIMEZONE;
    if (data.routeDate !== orgToday(tz)) return { minted: false as const };

    const { actionTokenExpiry } = await import("@/lib/live-activity-action");
    const { newActionToken, hashActionToken } = await import("@/lib/live-activity-action.server");
    const now = new Date();
    const expiresAt = actionTokenExpiry({
      now,
      routeDate: data.routeDate,
      tz,
      workdayEnd: org?.workday_end as string | null,
    });
    const token = newActionToken();

    await db
      .from("live_activity_action_tokens")
      .update({ revoked_at: now.toISOString(), revoke_reason: "superseded" })
      .eq("user_id", userId)
      .is("revoked_at", null);
    const { error } = await db.from("live_activity_action_tokens").insert({
      user_id: userId,
      organization_id: staff.organization_id,
      staff_id: staff.id,
      route_date: data.routeDate,
      token_hash: hashActionToken(token),
      locale: data.language,
      expires_at: expiresAt.toISOString(),
      created_at: now.toISOString(),
    });
    if (error) throw new Error(error.message);
    return { minted: true as const, token, expiresAt: expiresAt.toISOString() };
  });

export const endLiveActivityToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        activityId,
        reason: z.enum(["dismissed", "finished", "clocked_out", "hidden", "signed_out"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const now = new Date().toISOString();
    const { error } = await context.supabase
      .from("live_activity_tokens")
      .update({ ended_at: now, end_reason: data.reason })
      .eq("user_id", context.userId)
      .eq("activity_id", data.activityId)
      .is("ended_at", null);
    if (error) throw new Error(error.message);
    // The route is off the lock screen, so its Start button is gone, and so
    // is anything that could press it: revoke the caller's action tokens.
    const { revokeActionTokens } = await import("@/lib/live-activity-action.server");
    await revokeActionTokens(context.userId, data.reason);
    return { ok: true };
  });
