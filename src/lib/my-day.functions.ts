import { createServerFn } from "@tanstack/react-start";
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
        "id, organization_id, scheduled_on, status, sequence, started_at, completed_at, skip_reason, skip_reason_code, client_id, property_id, clients(display_name, primary_phone), properties(street, city, postal_code, gate_code, lock_box_code, key_location, parking_notes, access_notes, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes), zones(name), visit_photos(id, storage_path, kind)",
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
    if (!officeRole || !roleRow?.organization_id) return { staff: [] as { id: string; display_name: string; role: string }[] };
    const { data, error } = await supabase
      .from("staff")
      .select("id, display_name, role, active, is_field_tech")
      .eq("organization_id", roleRow.organization_id)
      .eq("active", true)
      .order("display_name", { ascending: true });
    if (error) throw new Error(error.message);
    const rows = (data ?? []).filter((s: any) => s.is_field_tech !== false);
    return { staff: rows.map((s: any) => ({ id: s.id, display_name: s.display_name, role: s.role })) };
  });


export const startVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("start_visit", { _visit_id: data.visitId });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const completeVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("complete_visit", { _visit_id: data.visitId });
    if (error) throw new Error(error.message);

    // Fire visit-completed email (best-effort)
    try {
      const { data: v } = await context.supabase
        .from("visits")
        .select("organization_id, client_id, scheduled_on, properties(street, city, visit_contact_email)")
        .eq("id", data.visitId)
        .single();
      if (v) {
        const prop: any = Array.isArray((v as any).properties) ? (v as any).properties[0] : (v as any).properties;
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
        .select("organization_id, client_id, clients(id, display_name, sms_opt_out, primary_phone, review_asked_at), organizations!inner(name, review_ask_enabled, google_review_url, sms_from_number, review_ask_template)")
        .eq("id", data.visitId)
        .single();
      const c: any = v && (Array.isArray((v as any).clients) ? (v as any).clients[0] : (v as any).clients);
      const o: any = v && (Array.isArray((v as any).organizations) ? (v as any).organizations[0] : (v as any).organizations);
      const ninetyDaysAgo = Date.now() - 90 * 24 * 3600_000;
      const eligible =
        o?.review_ask_enabled &&
        o?.google_review_url &&
        c?.id &&
        (!c?.review_asked_at || new Date(c.review_asked_at).getTime() < ninetyDaysAgo);
      if (eligible) {
        const orgId = (v as any).organization_id;
        // Review asks ride the tenant's OWN Twilio number; when not connected,
        // fall back to email (never the platform SMS number).
        const { resolveOrgTwilioConfig } = await import("@/lib/twilio-credentials.server");
        const tenant = await resolveOrgTwilioConfig(orgId);
        if (tenant && c.primary_phone && !c.sms_opt_out) {
          const firstName = (c.display_name ?? "").split(/\s+/)[0] || "there";
          const template =
            (o.review_ask_template && String(o.review_ask_template).trim()) ||
            `Hi {name}, thanks for choosing ${o.name ?? "us"}! If we did a great job, a quick review would mean the world: {link} Reply STOP to opt out.`;
          const body = template.replace(/\{name\}/g, firstName).replace(/\{link\}/g, o.google_review_url);
          const { sendTwilioSms } = await import("@/lib/twilio.server");
          try {
            const res = await sendTwilioSms({
              to: c.primary_phone,
              body,
              from: tenant.from ?? undefined,
              messagingServiceSid: tenant.messagingServiceSid ?? undefined,
              credentials: { mode: "direct", accountSid: tenant.accountSid, authToken: tenant.authToken },
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
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.rpc("skip_visit", {
      _visit_id: data.visitId,
      _reason: data.reason,
      _code: data.code,
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

    const { error } = await supabase.from("visit_photos").insert({
      visit_id: data.visitId,
      organization_id: v.organization_id,
      uploaded_by: userId,
      storage_path: data.storagePath,
      kind: data.kind,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
