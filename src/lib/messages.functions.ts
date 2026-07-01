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
    if (!org.sms_from_number)
      throw new Error("Your organization has no SMS sender number set. Add one in Settings → SMS.");

    const { data: staff } = await supabase
      .from("staff")
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", client.organization_id)
      .maybeSingle();

    const { sendTwilioSms } = await import("@/lib/twilio.server");
    let sid: string | null = null;
    let status = "queued";
    let errorText: string | null = null;
    try {
      const res = await sendTwilioSms({
        from: org.sms_from_number,
        to: client.primary_phone,
        body: data.body,
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
        from_number: org.sms_from_number,
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
    const { data: role } = await supabase
      .from("user_roles")
      .select("organization_id, role")
      .eq("user_id", userId)
      .maybeSingle();
    if (!role) throw new Error("No organization");
    const { error } = await supabase
      .from("organizations")
      .update({ sms_from_number: data.number || null })
      .eq("id", role.organization_id);
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
      .select("id, client_id, scheduled_on, organization_id, clients(display_name)")
      .eq("id", data.visitId)
      .single();
    if (error) throw new Error(error.message);
    const name = (v as any).clients?.display_name ?? "there";
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
    if (!client.primary_phone) throw new Error("Client has no phone number on file");
    if (client.sms_opt_out) throw new Error("Client has opted out of SMS.");
    const { data: org } = await supabase
      .from("organizations")
      .select("sms_from_number")
      .eq("id", client.organization_id)
      .single();
    if (!org?.sms_from_number)
      throw new Error("Your organization has no SMS sender number set. Add one in Settings → SMS.");
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
      const r = await sendTwilioSms({ from: org.sms_from_number, to: client.primary_phone, body });
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
      from_number: org.sms_from_number,
      to_number: client.primary_phone,
      twilio_sid: sid,
      status: status as any,
      error: err,
    });
    if (err) throw new Error(err);
    return { ok: true };
  });
