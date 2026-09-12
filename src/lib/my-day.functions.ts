import { createServerFn } from "@tanstack/react-start";
import { orgToday } from "@/lib/org-day";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const getMyDay = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        day: z.string(),
        // Optional: office roles (owner/office_manager/dispatcher) can preview
        // another tech's day. Ignored for techs — they always see their own.
        staffId: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    // Caller's own staff record (may be null for pure office/dispatch users).
    const { data: myStaffRow, error: myStaffErr } = await supabase
      .from("staff")
      .select("id, organization_id, display_name, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (myStaffErr) throw new Error(myStaffErr.message);

    // Determine which staff row to load visits for. If a staffId is supplied,
    // verify the caller has an office role in that staff's org before honoring
    // it. Otherwise fall back to the caller's own staff row.
    let targetStaff = myStaffRow;
    let previewing = false;
    if (data.staffId && data.staffId !== myStaffRow?.id) {
      const { data: roleRow } = await supabase
        .from("user_roles")
        .select("role, organization_id")
        .eq("user_id", userId)
        .maybeSingle();
      const officeRole =
        roleRow?.role === "owner" ||
        roleRow?.role === "office_manager" ||
        roleRow?.role === "dispatcher";
      if (!officeRole) throw new Error("Not authorized to preview another tech's day");
      const { data: targetRow, error: targetErr } = await supabase
        .from("staff")
        .select("id, organization_id, display_name, role")
        .eq("id", data.staffId)
        .eq("organization_id", roleRow!.organization_id!)
        .maybeSingle();
      if (targetErr) throw new Error(targetErr.message);
      if (!targetRow) throw new Error("Staff member not found in your organization");
      targetStaff = targetRow;
      previewing = true;
    }

    if (!targetStaff) return { staff: null, visits: [] as any[], previewing: false };

    const { data: visits, error } = await supabase
      .from("visits")
      .select(
        // `skipped_at` was written by skip_visit and selected by nobody, so the
        // branch in my-day.tsx that renders it -- added by
        // 20260804110000 precisely so a REPLAYED skip shows the time the tech
        // actually stood at the door, not the time their signal came back --
        // has been dead since the day it was written.
        "id, organization_id, scheduled_on, status, sequence, started_at, completed_at, skipped_at, eta_start, eta_end, skip_reason, skip_reason_code, client_id, property_id, clients(display_name, primary_phone, dna_compliance_enabled), properties(street, city, postal_code, latitude, longitude, account_type, has_units, gate_code, lock_box_code, key_location, parking_notes, access_notes, yard_size, earliest_service_time, latest_service_time, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes, dogs(name, temperament)), zones(name), visit_photos(id, storage_path, kind)",
      )
      .eq("assigned_staff_id", targetStaff.id)
      .eq("scheduled_on", data.day)
      .order("sequence", { ascending: true, nullsFirst: false });
    if (error) throw new Error(error.message);

    return { staff: targetStaff, visits: visits ?? [], previewing };
  });

export const listMyDayFieldStaff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: roleRow } = await supabase
      .from("user_roles")
      .select("role, organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    const officeRole =
      roleRow?.role === "owner" ||
      roleRow?.role === "office_manager" ||
      roleRow?.role === "dispatcher";
    if (!officeRole || !roleRow?.organization_id)
      return { staff: [] as { id: string; display_name: string; role: string }[] };
    const { data, error } = await supabase
      .from("staff")
      .select("id, display_name, role, active, is_field_tech")
      .eq("organization_id", roleRow.organization_id)
      .eq("active", true)
      .order("display_name", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []).filter((s: any) => s.is_field_tech !== false);
    return {
      staff: rows.map((s: any) => ({ id: s.id, display_name: s.display_name, role: s.role })),
    };
  });

export const startVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        /** When the tech actually started, for a REPLAYED action. */
        startedAt: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("start_visit", {
      _visit_id: data.visitId,
      _started_at: data.startedAt ?? undefined,
    });
    if (error) throw new Error(error.message);
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select("organization_id, client_id, property_id, scheduled_on")
        .eq("id", data.visitId)
        .single();
      if (v) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: v.organization_id,
          clientId: v.client_id,
          propertyId: v.property_id,
          actorUserId: context.userId,
          kind: "visit.started",
          summary: `Started the visit scheduled for ${v.scheduled_on}`,
        });
      }
    } catch (e) {
      // Best-effort: the visit already started (the rpc above throws on
      // failure), and a broken activity log must not fail the tech's tap. But
      // it was `catch {}` — so activity logging could stop working for every
      // visit in every org and leave no trace anywhere to find it by.
      console.warn("visit.started activity log failed", data.visitId, e);
    }
    return { ok: true };
  });

export const completeVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        // When the tech actually finished, for a REPLAYED action. Absent on the
        // live path. The SQL decides whether to believe it — a phone clock is a
        // hint, never the safeguard — and records the replay in
        // completion_source either way.
        completedAt: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("complete_visit", {
      _visit_id: data.visitId,
      _completed_at: data.completedAt ?? undefined,
    });
    if (error) throw new Error(error.message);
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select("organization_id, client_id, property_id, scheduled_on")
        .eq("id", data.visitId)
        .single();
      if (v) {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(context.supabase, {
          orgId: v.organization_id,
          clientId: v.client_id,
          propertyId: v.property_id,
          actorUserId: context.userId,
          kind: "visit.completed",
          summary: `Completed the visit scheduled for ${v.scheduled_on}`,
        });
      }
    } catch (e) {
      console.warn("visit.completed activity log failed", data.visitId, e);
    }

    // Fire visit-completed email (best-effort)
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select(
          "organization_id, client_id, scheduled_on, properties(street, city, visit_contact_email)",
        )
        .eq("id", data.visitId)
        .single();
      if (v) {
        const prop: any = Array.isArray((v as any).properties)
          ? (v as any).properties[0]
          : (v as any).properties;
        const address = prop ? [prop.street, prop.city].filter(Boolean).join(", ") : undefined;
        const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
        await enqueueAppEmail({
          organizationId: v.organization_id,
          clientId: v.client_id,
          templateName: "visit-completed",
          notifyKey: "notify_email_visit_completed",
          idempotencyKey: `visit-done-${data.visitId}`,
          // P3.5: visit emails go to the property's own contact when one is
          // set (tenant/manager); billing emails stay with the client.
          toOverride: prop?.visit_contact_email || undefined,
          templateData: {
            visitDate: v.scheduled_on,
            address,
          },
        });
        // Best-effort push notification to the client (if they subscribed via portal).
        try {
          const { sendPushToClient } = await import("@/lib/push.server");
          await sendPushToClient(v.client_id, {
            title: "Visit completed",
            body: address ? `We just cleaned up at ${address}.` : "Your yard visit is complete.",
            tag: `visit-${data.visitId}`,
            url: "/portal",
          });
        } catch (e) {
          console.error("client push failed", e);
        }
      }
    } catch (e) {
      console.error("visit-completed email failed", e);
    }

    // Best-effort: fire an automated Google review SMS if org enabled it and
    // this client hasn't been asked recently. Only completed visits qualify.
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select(
          "organization_id, client_id, clients(id, display_name, sms_opt_out, comms_paused, primary_phone, review_asked_at), organizations!inner(name, review_ask_enabled, google_review_url, sms_from_number, review_ask_template)",
        )
        .eq("id", data.visitId)
        .single();
      const c: any =
        v && (Array.isArray((v as any).clients) ? (v as any).clients[0] : (v as any).clients);
      const o: any =
        v &&
        (Array.isArray((v as any).organizations)
          ? (v as any).organizations[0]
          : (v as any).organizations);
      const ninetyDaysAgo = Date.now() - 90 * 24 * 3600_000;
      const eligible =
        o?.review_ask_enabled &&
        o?.google_review_url &&
        c?.id &&
        // Imported comms hold: no automated review asks (SMS or email) until
        // the org initiates contact with this client.
        !c?.comms_paused &&
        (!c?.review_asked_at || new Date(c.review_asked_at).getTime() < ninetyDaysAgo);
      if (eligible) {
        const orgId = (v as any).organization_id;
        // Review asks ride the tenant's OWN Twilio number; when not connected,
        // fall back to email (never the platform SMS number).
        const { resolveOrgTwilioConfig } = await import("@/lib/twilio-credentials.server");
        const tenant = await resolveOrgTwilioConfig(orgId);
        // Same consent gate as every other sender. Without it the nightly
        // job is the single largest source of un-consented traffic, which is
        // precisely what a toll-free number gets shut off for.
        const { data: mayTextDaily } = await (context.supabase as any).rpc("client_may_be_texted", {
          _client_id: c.id,
        });
        if (tenant && mayTextDaily) {
          const firstName = (c.display_name ?? "").split(/\s+/)[0] || "there";
          const template =
            (o.review_ask_template && String(o.review_ask_template).trim()) ||
            `Hi {name}, thanks for choosing ${o.name ?? "us"}! If we did a great job, a quick review would mean the world: {link} Reply STOP to opt out.`;
          const body = template
            .replace(/\{name\}/g, firstName)
            .replace(/\{link\}/g, o.google_review_url);
          const { sendTwilioSms } = await import("@/lib/twilio.server");
          try {
            const res = await sendTwilioSms({
              to: c.primary_phone,
              body,
              from: tenant.from ?? undefined,
              messagingServiceSid: tenant.messagingServiceSid ?? undefined,
              credentials: {
                mode: "direct",
                accountSid: tenant.accountSid,
                authToken: tenant.authToken,
              },
            });
            await context.supabase.from("messages").insert({
              organization_id: orgId,
              client_id: c.id,
              visit_id: data.visitId,
              direction: "outbound",
              body,
              from_number: tenant.from ?? null,
              to_number: c.primary_phone,
              twilio_sid: res.sid,
              status: (res.status || "sent") as any,
            });
            await context.supabase.rpc("mark_review_asked", { _client_id: c.id });
          } catch (err) {
            console.error("auto review SMS failed", err);
          }
        } else {
          const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
          const r = await enqueueAppEmail({
            organizationId: orgId,
            clientId: c.id,
            templateName: "review-request",
            notifyKey: "notify_email_review_request",
            idempotencyKey: `review-${c.id}-${new Date().toISOString().slice(0, 10)}`,
            templateData: { reviewUrl: o.google_review_url },
          });
          if (r.ok) await context.supabase.rpc("mark_review_asked", { _client_id: c.id });
        }
      }
    } catch (e) {
      console.error("auto review request failed", e);
    }
    return { ok: true };
  });

export const skipVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        reason: z.string().min(1).max(500),
        code: z
          .enum([
            "client_cancelled_late",
            "gate_locked",
            "dog_outside",
            "weather",
            "our_fault",
            "access_blocked",
            "unsafe_conditions",
            "other",
          ])
          .default("other"),
        /** When the tech actually skipped, for a REPLAYED action. */
        skippedAt: z.string().datetime().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("skip_visit", {
      _visit_id: data.visitId,
      _reason: data.reason,
      _code: data.code,
      _skipped_at: data.skippedAt ?? undefined,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const recordVisitPhoto = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        storagePath: z.string().min(1),
        kind: z.enum(["completion", "before", "issue"]).default("completion"),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: v, error: vErr } = await supabase
      .from("visits")
      .select("organization_id")
      .eq("id", data.visitId)
      .single();
    if (vErr) throw new Error(vErr.message);

    // Idempotent, because this is the second of two steps and the offline queue
    // replays the pair. The upload can land and this call's RESPONSE be lost --
    // a dropped connection, the 45s deadline -- and the replay then re-records
    // a path already recorded, showing the customer the same photograph twice.
    //
    // `ignoreDuplicates` needs the unique index added in 20260903110000; with
    // the storage UPDATE policy from the same file it is what finally makes a
    // photo action safe to replay however far it got the first time.
    const { error } = await supabase.from("visit_photos").upsert(
      {
        visit_id: data.visitId,
        organization_id: v.organization_id,
        uploaded_by: userId,
        storage_path: data.storagePath,
        kind: data.kind,
      },
      { onConflict: "visit_id,storage_path", ignoreDuplicates: true },
    );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ── BUILD-11: end-of-day close-out ───────────────────────────────────────────
//
// A visit the tech started and never finished is currently immortal: the
// nightly missed-visit job skips anything with a started_at, so nothing ever
// resolves it and it simply drops off the tech's day when the date rolls over.
//
// Nothing here completes anything on its own. This finds the open visits worth
// ASKING about; the tech answers, and confirmOpenVisit records their answer.

/** Open visits belonging to the calling tech that are past the point where they
 *  can still plausibly be in progress. Scoped to the caller's own staff row —
 *  this is a prompt about your own forgotten work, not a supervision tool. */
export const listVisitsAwaitingCloseOut = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;

    const { data: staffRow } = await supabase
      .from("staff")
      .select("id, organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!staffRow) return { visits: [] as OpenVisitRow[] };

    const { data: org } = await (supabase as any)
      .from("organizations")
      .select("timezone, workday_end")
      .eq("id", staffRow.organization_id)
      .maybeSingle();

    // Org-local, never UTC — the same rule the portal's "today" follows, and
    // for the same reason: a tech west of UTC would otherwise be prompted about
    // today's visit hours before their day is actually over (BUG-12).
    const { DEFAULT_TIMEZONE } = await import("@/lib/route-window");
    const tz = org?.timezone || DEFAULT_TIMEZONE;
    const now = new Date();
    // The third hand-rolled copy of this formatter. One definition now.
    const orgLocalToday = orgToday(tz, now);
    const orgLocalTime = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);

    // Bounded lookback: a visit open for months is a data problem for the
    // office, not something to nag a tech about every morning forever.
    const since = new Date(now.getTime() - 14 * 86400_000).toISOString().slice(0, 10);

    const { data: rows, error } = await (supabase as any)
      .from("visits")
      .select(
        "id, scheduled_on, started_at, status, clients(display_name), properties(street, city)",
      )
      .eq("assigned_staff_id", staffRow.id)
      .eq("status", "in_progress")
      .gte("scheduled_on", since)
      .order("scheduled_on", { ascending: true });
    if (error) throw new Error(error.message);

    const { isVisitAwaitingCloseOut } = await import("@/lib/visit-lifecycle");
    const visits = (rows ?? []).filter((v: any) =>
      isVisitAwaitingCloseOut(v, orgLocalToday, orgLocalTime, org?.workday_end ?? null),
    );
    return { visits: visits as OpenVisitRow[] };
  });

export type OpenVisitRow = {
  id: string;
  scheduled_on: string;
  started_at: string | null;
  status: string;
  clients?: { display_name?: string | null } | null;
  properties?: { street?: string | null; city?: string | null } | null;
};

/** Record the tech's answer about a visit they left open.
 *
 *  The completion time is the tech's ASSERTION, not a measurement, so it is
 *  stored with completion_source='late_confirmation' and validated in the
 *  database against the recorded start. That is what stops this path from
 *  recreating the BUG-9 rows (completion == start) by construction. */
export const confirmOpenVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        completed: z.boolean(),
        // Required when completed; ignored otherwise. Validated server-side
        // against started_at — the client hint is never the safeguard.
        completedAt: z.string().datetime().optional(),
        note: z.string().trim().max(500).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    if (data.completed && !data.completedAt) {
      throw new Error("Tell us what time the visit finished");
    }

    const { data: outcome, error } = await (supabase as any).rpc("confirm_open_visit", {
      _visit_id: data.visitId,
      _completed: data.completed,
      _completed_at: data.completedAt ?? undefined,
      _note: data.note ?? null,
    });
    if (error) throw new Error(error.message);

    // Audit the assertion, not just the state change: a completion nobody
    // measured should be legible as such on the timeline afterwards (10.6).
    try {
      const { data: v } = await supabase
        .from("visits")
        .select("organization_id, client_id, property_id, scheduled_on")
        .eq("id", data.visitId)
        .single();
      if (v && outcome !== "already_resolved") {
        const { logActivity } = await import("@/lib/activity.server");
        await logActivity(supabase, {
          orgId: v.organization_id,
          clientId: v.client_id,
          propertyId: v.property_id,
          actorUserId: userId,
          kind: outcome === "completed" ? "visit.completed_late" : "visit.missed_confirmed",
          summary:
            outcome === "completed"
              ? `Confirmed after the fact that the ${v.scheduled_on} visit was completed (finish time entered by the tech, not measured)`
              : `Confirmed the ${v.scheduled_on} visit was left unfinished`,
          meta: { visit_id: data.visitId, completed_at: data.completedAt ?? null },
        });
      }
    } catch {
      /* audit is best-effort — never block the close-out */
    }

    return { outcome: (outcome ?? "already_resolved") as string };
  });
