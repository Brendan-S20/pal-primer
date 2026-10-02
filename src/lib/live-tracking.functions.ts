// Live "your tech is on the way" tracking: the four server functions.
//
// Three are the tech's, on the caller's own client, so RLS is the check: a
// position can only be written for a visit assigned to the caller, in their
// org, while the window is open (may_share_live_location in
// supabase/migrations/20260929100000_nobody-could-see-the-truck-coming.sql).
// The fourth is the customer's, with NO auth middleware, exactly like
// getPublicQuote / getPublicInvoice: the unguessable visits.tracking_token is
// the capability, and it reaches the database through the service-role
// client and public_visit_tracking, the SECURITY DEFINER function that does
// the rounding and the hiding.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import {
  publicTrackingView,
  sharingWindow,
  type PublicTracking,
  type TrackingDoc,
} from "@/lib/live-tracking";

export type MyLiveShare =
  | { enabled: false }
  | {
      enabled: true;
      /** The visit whose customer can see the caller right now, if any. */
      active: { visitId: string; customerName: string; until: string } | null;
      /** The caller's next stop today that has not been announced yet, so the
       *  card can say before it happens that Navigate will start sharing. */
      nextVisitId: string | null;
    };

/** Is the caller's location being shared, and for which visit? One query for
 *  the whole of My Day: every card reads the same answer. */
export const getMyLiveShare = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<MyLiveShare> => {
    const { supabase, userId } = context;
    const { data: staff } = await supabase
      .from("staff")
      .select("id, organization_id, active")
      .eq("user_id", userId)
      .maybeSingle();
    if (!staff || !staff.active) return { enabled: false };

    const { data: org } = await supabase
      .from("organizations")
      .select("live_tracking_enabled, timezone")
      .eq("id", staff.organization_id)
      .maybeSingle();
    if (!org?.live_tracking_enabled) return { enabled: false };

    const now = new Date();
    const since = new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString();
    // You drive to one place at a time: the most recent announcement wins.
    const { data: rows } = await supabase
      .from("visits")
      .select(
        "id, status, on_my_way_sent_at, live_tracking_stopped_at, clients(display_name), properties(visit_contact_name, visit_contact_phone)",
      )
      .eq("assigned_staff_id", staff.id)
      .eq("status", "scheduled")
      .gte("on_my_way_sent_at", since)
      .order("on_my_way_sent_at", { ascending: false })
      .limit(1);
    const v = rows?.[0] as any;
    let active: { visitId: string; customerName: string; until: string } | null = null;
    if (v) {
      const w = sharingWindow({
        enabled: true,
        status: v.status,
        onMyWaySentAt: v.on_my_way_sent_at,
        stoppedAt: v.live_tracking_stopped_at,
        now,
      });
      if (w.share) {
        const prop = Array.isArray(v.properties) ? v.properties[0] : v.properties;
        const client = Array.isArray(v.clients) ? v.clients[0] : v.clients;
        // The same rule as the text: the property's own contact, when it has
        // one, is who is waiting at the gate.
        const customerName =
          (prop?.visit_contact_phone ? prop?.visit_contact_name : null) ??
          client?.display_name ??
          "the customer";
        active = { visitId: v.id, customerName, until: w.until.toISOString() };
      }
    }

    const today = orgToday(org.timezone || DEFAULT_ORG_TIMEZONE, now);
    const { data: next } = await supabase
      .from("visits")
      .select("id")
      .eq("assigned_staff_id", staff.id)
      .eq("scheduled_on", today)
      .eq("status", "scheduled")
      .is("on_my_way_sent_at", null)
      .order("sequence", { ascending: true, nullsFirst: false })
      .order("eta_start", { ascending: true, nullsFirst: false })
      .limit(1);

    return { enabled: true, active, nextVisitId: (next?.[0]?.id as string | undefined) ?? null };
  });

/** Post the tech's current position for the visit they are driving to.
 *  `stop: true` tells the phone the window has closed, so it stops asking. */
export const postLiveLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        accuracy: z.number().min(0).max(100_000).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: boolean; stop: boolean }> => {
    const { supabase, userId } = context;
    const { data: v } = await supabase
      .from("visits")
      .select("id, organization_id")
      .eq("id", data.visitId)
      .maybeSingle();
    if (!v) return { ok: false, stop: true };
    const { data: staff } = await supabase
      .from("staff")
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", v.organization_id)
      .maybeSingle();
    if (!staff) return { ok: false, stop: true };
    // recorded_at is stamped by the database; anything sent here is ignored.
    const { error } = await supabase.from("visit_live_locations").upsert(
      {
        visit_id: v.id,
        organization_id: v.organization_id,
        staff_id: staff.id,
        lat: data.lat,
        lng: data.lng,
        accuracy: data.accuracy ?? null,
      },
      { onConflict: "visit_id" },
    );
    if (error) {
      // 42501 is RLS saying no: the window is closed (started, two hours,
      // stopped, or tracking turned off). Anything else is worth one retry.
      return { ok: false, stop: error.code === "42501" };
    }
    return { ok: true, stop: false };
  });

/** The tech's Stop button. Stamping the visit is what makes it stick: the
 *  database deletes the position (trigger) and refuses the next one until a
 *  newer "on my way" is sent. */
export const stopLiveLocation = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { error } = await supabase
      .from("visits")
      .update({ live_tracking_stopped_at: new Date().toISOString() })
      .eq("id", data.visitId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getPublicTracking = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }): Promise<PublicTracking> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: doc, error } = await supabaseAdmin.rpc("public_visit_tracking", {
      _token: data.token,
    });
    if (error) throw new Error("This page could not be loaded. Please try again.");
    return publicTrackingView((doc as unknown as TrackingDoc | null) ?? null);
  });
