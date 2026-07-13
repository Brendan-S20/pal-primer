import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listMessageThreads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!role) return { threads: [] as any[] };

    // Get latest 500 messages, group in JS by client.
    const { data, error } = await supabase
      .from("messages")
      .select("id, client_id, direction, body, created_at, status, clients(display_name, primary_phone, sms_opt_out)")
      .eq("organization_id", role.organization_id)
      .not("client_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);

    const seen = new Map<string, any>();
    for (const m of data ?? []) {
      if (!m.client_id) continue;
      if (!seen.has(m.client_id)) seen.set(m.client_id, m);
    }
    return { threads: Array.from(seen.values()) };
  });

export const listClientMessages = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, display_name, primary_phone, sms_opt_out, organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    const { data: messages, error } = await supabase
      .from("messages")
      .select("id, direction, body, from_number, to_number, status, error, created_at, staff_id")
      .eq("client_id", data.clientId)
      .order("created_at", { ascending: true })
      .limit(500);
    if (error) throw new Error(error.message);
    return { client, messages: messages ?? [] };
  });

export const sendSmsToClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        body: z.string().trim().min(1).max(1500),
        visitId: z.string().uuid().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;

    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, primary_phone, sms_opt_out, display_name")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (!client.primary_phone) throw new Error("Client has no phone number on file");
    if (client.sms_opt_out) throw new Error("Client has opted out of SMS (STOP). Cannot send.");

    const { data: org, error: oErr } = await supabase
      .from("organizations")
      .select("sms_from_number")
      .eq("id", client.organization_id)
      .single();
    if (oErr) throw new Error(oErr.message);

    const { data: staff } = await supabase
      .from("staff")
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", client.organization_id)
      .maybeSingle();

    // Conversation channel: prefer the org's own (BYOK) Twilio; fall back to the
    // platform gateway with the org's legacy sms_from_number until they onboard.
    const { resolveOrgTwilioConfig } = await import("@/lib/twilio-credentials.server");
    const tenant = await resolveOrgTwilioConfig(client.organization_id);
    const fromNumber = tenant?.from ?? org.sms_from_number ?? null;
    if (!tenant?.messagingServiceSid && !fromNumber)
      throw new Error("Your organization has no SMS sender configured. Add one in Settings → SMS.");

    const { sendTwilioSms } = await import("@/lib/twilio.server");
    let sid: string | null = null;
    let status = "queued";
    let errorText: string | null = null;
    try {
      const res = await sendTwilioSms({
        to: client.primary_phone,
        body: data.body,
        from: fromNumber ?? undefined,
        messagingServiceSid: tenant?.messagingServiceSid ?? undefined,
        credentials: tenant
          ? { mode: "direct", accountSid: tenant.accountSid, authToken: tenant.authToken }
          : { mode: "gateway" },
      });
      sid = res.sid;
      status = res.status || "sent";
    } catch (e: any) {
      errorText = e?.message ?? String(e);
      status = "failed";
    }

    const { data: inserted, error: insErr } = await supabase
      .from("messages")
      .insert({
        organization_id: client.organization_id,
        client_id: client.id,
        visit_id: data.visitId ?? null,
        staff_id: staff?.id ?? null,
        direction: "outbound",
        body: data.body,
        from_number: fromNumber,
        to_number: client.primary_phone,
        twilio_sid: sid,
        status: status as any,
        error: errorText,
      })
      .select("id")
      .single();
    if (insErr) throw new Error(insErr.message);
    if (errorText) throw new Error(errorText);
    return { id: inserted.id, sid, status };
  });

export const updateOrgSmsFromNumber = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        number: z
          .string()
          .trim()
          .regex(/^\+[1-9]\d{6,15}$/i, "Must be an E.164 number, e.g. +15558675310")
          .or(z.literal("")),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // Setting the org's SMS sender number is an org-config change — gate it at
    // manage_settings (owner/office_manager), not bare membership (#34).
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(supabase, userId, "manage_settings");
    // Security (Twilio H1): a sender number belongs to one org only.
    if (data.number) {
      const { data: taken } = await (supabase.from("organizations") as any)
        .select("id").eq("sms_from_number", data.number).neq("id", orgId).maybeSingle();
      if (taken) throw new Error("That number is already in use by another account.");
    }
    const { error } = await supabase
      .from("organizations")
      .update({ sms_from_number: data.number || null })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// Convenience: send templated status update for a specific visit.
export const sendVisitStatusSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        kind: z.enum(["reminder", "on_my_way", "completed"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { data: v, error } = await supabase
      .from("visits")
      .select("id, client_id, scheduled_on, organization_id, clients(display_name), properties(visit_contact_name, visit_contact_phone)")
      .eq("id", data.visitId)
      .single();
    if (error) throw new Error(error.message);
    // P3.5: a property can name its own on-site contact (tenant, property
    // manager) — visit-lifecycle texts go to them when set; billing texts
    // stay with the client's primary contact.
    const propContact = (v as any).properties as
      | { visit_contact_name: string | null; visit_contact_phone: string | null }
      | null;
    const name = propContact?.visit_contact_phone
      ? (propContact.visit_contact_name ?? "there")
      : ((v as any).clients?.display_name ?? "there");
    const body =
      data.kind === "reminder"
        ? `Hi ${name}, this is a reminder your yard cleanup is scheduled for ${v.scheduled_on}. Reply STOP to opt out.`
        : data.kind === "on_my_way"
          ? `Hi ${name}, your tech is on the way for today's yard cleanup. Reply STOP to opt out.`
          : `Hi ${name}, your yard cleanup is complete for ${v.scheduled_on}. Thanks! Reply STOP to opt out.`;

    // Reuse sendSmsToClient path by inlining its logic isn't trivial; call directly.
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, primary_phone, sms_opt_out")
      .eq("id", v.client_id!)
      .single();
    if (cErr) throw new Error(cErr.message);
    const destPhone = propContact?.visit_contact_phone || client.primary_phone;
    if (!destPhone) throw new Error("No phone number on file for this visit's contact or the client");
    // Account-level opt-out covers the property contact too — conservative on
    // consent until per-contact opt-out exists.
    if (client.sms_opt_out) throw new Error("Client has opted out of SMS.");
    const { data: org } = await supabase
      .from("organizations")
      .select("sms_from_number, notify_sms_visit_reminder, notify_sms_on_my_way, notify_sms_visit_completed")
      .eq("id", client.organization_id)
      .single();
    if (!org) throw new Error("Organization not found");
    // Automated notification → PLATFORM Twilio (prefer the platform sender
    // number; fall back to the org's legacy number only if unset).
    const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
    const notifyFrom = platformTwilioFrom() ?? org.sms_from_number ?? null;
    if (!notifyFrom)
      throw new Error("No SMS sender is configured for notifications. Add one in Settings → SMS.");
    const kindEnabled =
      data.kind === "reminder" ? org.notify_sms_visit_reminder :
      data.kind === "on_my_way" ? org.notify_sms_on_my_way :
      org.notify_sms_visit_completed;
    if (!kindEnabled) throw new Error("This notification is turned off in Settings → Automation.");
    const { data: staff } = await supabase
      .from("staff")
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", client.organization_id)
      .maybeSingle();

    const { sendTwilioSms } = await import("@/lib/twilio.server");
    let sid: string | null = null;
    let status = "queued";
    let err: string | null = null;
    try {
      const r = await sendTwilioSms({ from: notifyFrom, to: destPhone, body });
      sid = r.sid;
      status = r.status || "sent";
    } catch (e: any) {
      err = e?.message ?? String(e);
      status = "failed";
    }
    await supabase.from("messages").insert({
      organization_id: client.organization_id,
      client_id: client.id,
      visit_id: v.id,
      staff_id: staff?.id ?? null,
      direction: "outbound",
      body,
      from_number: notifyFrom,
      to_number: destPhone,
      twilio_sid: sid,
      status: status as any,
      error: err,
    });
    if (err) throw new Error(err);
    return { ok: true };
  });
