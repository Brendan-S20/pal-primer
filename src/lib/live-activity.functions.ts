// Saving and ending the push token of the route on a tech's lock screen.
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

export const endLiveActivityToken = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        activityId,
        reason: z.enum(["dismissed", "finished", "clocked_out", "hidden"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase
      .from("live_activity_tokens")
      .update({ ended_at: new Date().toISOString(), end_reason: data.reason })
      .eq("user_id", context.userId)
      .eq("activity_id", data.activityId)
      .is("ended_at", null);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
