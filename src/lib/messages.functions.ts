import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { formatDay } from "@/lib/format";

/** Said when a business has no texting number of its own yet, which until
 *  per-business numbers clear carrier registration is every business. */
const NO_TEXTING_YET =
  "Texting clients isn't available for your business yet. It turns on when your business's own texting number is registered with the carriers. Until then, use email or call.";

export const listMessageThreads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    // The message inbox exposes every client's name, phone, and SMS history —
    // a client-directory read (dispatcher/office/owner), not a technician one
    // (I7). RLS only tenant-scopes messages, it does not check role.
    const { orgId } = await requirePermission(supabase, userId, "view_client_directory");

    // Get latest 500 messages, group in JS by client.
    const { data, error } = await supabase
      .from("messages")
      .select("id, client_id, direction, body, created_at, status, clients(display_name, primary_phone, sms_opt_out)")
      .eq("organization_id", orgId)
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
    const { supabase, userId } = context;
    // Reading a client's full message thread is a client-directory action (I7).
    await requirePermission(supabase, userId, "view_client_directory");
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
    // Sending a free-form SMS to a client (which reads their phone number and
    // dispatches Twilio) is a client-directory/messaging action — reject a
    // technician token BEFORE any provider side-effect (I7). Lifecycle "on my
    // way" texts have their own tech-appropriate path (sendVisitStatusSms).
    await requirePermission(supabase, userId, "view_client_directory");

    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, primary_phone, sms_opt_out, display_name, comms_paused")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (!client.primary_phone) throw new Error("Client has no phone number on file");
    if (client.sms_opt_out) throw new Error("Client has opted out of SMS (STOP). Cannot send.");
    // Consent, not just the absence of a refusal. `sms_opt_out` only ever went
    // true AFTER somebody replied STOP, so a client with no consent on file
    // read as sendable — the exact model Twilio rejected under 30513. The
    // check lives in SQL (`client_may_be_texted`) so every path asks the same
    // question, including ones added later.
    const { data: mayText, error: cErrConsent } = await (supabase as any).rpc(
      "client_may_be_texted",
      { _client_id: data.clientId },
    );
    if (cErrConsent) throw new Error(cErrConsent.message);
    if (!mayText) {
      throw new Error(
        "No texting consent on file for this client. Ask them to opt in from their portal, or record their consent on the client page.",
      );
    }


    const { data: staff } = await supabase
      .from("staff")
      .select("id")
      .eq("user_id", userId)
      .eq("organization_id", client.organization_id)
      .maybeSingle();

    // The business's own subaccount, or no text. This used to fall back to
    // the PLATFORM's account (gateway mode) with the org's legacy number,
    // which is HoundStack texting a business's client, and the toll-free
    // filing says it does not. See lib/twilio-credentials.server.
    const { endCustomerSmsSender } = await import("@/lib/twilio-credentials.server");
    const sender = await endCustomerSmsSender(client.organization_id);
    if (!sender) throw new Error(NO_TEXTING_YET);
    const fromNumber = sender.from;

    const { sendTwilioSms } = await import("@/lib/twilio.server");
    let sid: string | null = null;
    let status = "queued";
    let errorText: string | null = null;
    try {
      const res = await sendTwilioSms({
        to: client.primary_phone,
        body: data.body,
        from: sender.from ?? undefined,
        messagingServiceSid: sender.messagingServiceSid ?? undefined,
        credentials: sender.credentials,
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
    // A successful direct (user-initiated) message lifts the imported comms
    // hold — the org has now initiated contact.
    if (client.comms_paused) {
      await supabase.from("clients").update({ comms_paused: false }).eq("id", client.id);
    }
    try {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId: client.organization_id,
        clientId: data.clientId,
        actorUserId: context.userId,
        kind: "message.sent",
        summary: `Sent an SMS to the client`,
      });
    } catch {}
    return { id: inserted.id, sid, status };
  });

// IMP-9: updateOrgSmsFromNumber was removed here. It let an owner type their
// own conversational sender number, which only made sense while they supplied
// their own Twilio account. Under managed subaccounts (Q-8) the number is issued
// during provisioning, so an editable field was just somewhere to type a value
// that would be overwritten — and leaving the server function in place would
// have kept a tenant-facing write path open after its UI was gone.
// organizations.sms_from_number itself stays: provisioning writes it, and the
// inbound webhook finds a business by it. Nothing SENDS from it any more
// unless it is also the business's subaccount number (endCustomerSmsSender).

export const sendVisitStatusSms = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        // "on my way" moved to sendOnMyWayMessage, which names the tech,
        // gives an arrival window, and falls back to email.
        kind: z.enum(["reminder", "completed"]),
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
    // `scheduled_on` is a date column: interpolating it raw sent customers
    // "scheduled for 2026-08-12" — the database's format, in the two
    // highest-volume customer-facing strings in the product. formatDay gives
    // "Wed, Aug 12"; its noon anchor means the weekday can't slip a day.
    const day = formatDay(v.scheduled_on);
    // One word for one thing. These three texts called the job a "yard cleanup";
    // every other thing the customer reads calls it a visit — the portal's
    // "Upcoming visits" list and its Skip/Reschedule buttons, the visit-completed
    // and weather-reschedule emails ("Visit complete", "Visit rescheduled"), and
    // the SMS terms page, which promises "visit-completed confirmations" in those
    // words. "Visit" won on count and on being the term the product is built
    // around; "yard cleanup" survived only in this one switch. A customer who
    // skipped a visit in the portal and then got a text about a cleanup had to
    // work out for themselves that it was the same appointment.
    const body =
      data.kind === "reminder"
        ? `Hi ${name}, this is a reminder your visit is scheduled for ${day}. Reply STOP to opt out.`
        : `Hi ${name}, your visit is complete for ${day}. Thanks! Reply STOP to opt out.`;

    // Reuse sendSmsToClient path by inlining its logic isn't trivial; call directly.
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, primary_phone, sms_opt_out, comms_paused")
      .eq("id", v.client_id!)
      .single();
    if (cErr) throw new Error(cErr.message);
    const destPhone = propContact?.visit_contact_phone || client.primary_phone;
    if (!destPhone) throw new Error("No phone number on file for this visit's contact or the client");
    // Account-level opt-out covers the property contact too — conservative on
    // consent until per-contact opt-out exists.
    if (client.sms_opt_out) throw new Error("Client has opted out of SMS.");
    // Consent, not just the absence of a refusal. `sms_opt_out` only ever went
    // true AFTER somebody replied STOP, so a client with no consent on file
    // read as sendable — the exact model Twilio rejected under 30513. The
    // check lives in SQL (`client_may_be_texted`) so every path asks the same
    // question, including ones added later.
    const { data: mayText, error: cErrConsent } = await (supabase as any).rpc(
      "client_may_be_texted",
      { _client_id: v.client_id! },
    );
    if (cErrConsent) throw new Error(cErrConsent.message);
    if (!mayText) {
      throw new Error(
        "No texting consent on file for this client. Ask them to opt in from their portal, or record their consent on the client page.",
      );
    }

    // Imported comms hold: templated lifecycle texts (reminder / on my way /
    // completed) count as automated notifications, not personal outreach.
    if (client.comms_paused)
      throw new Error(
        "Communications are paused for this imported client. Send them a direct message or lift the hold on their client page first.",
      );
    const { data: org } = await supabase
      .from("organizations")
      .select("notify_sms_visit_reminder, notify_sms_visit_completed")
      .eq("id", client.organization_id)
      .single();
    if (!org) throw new Error("Organization not found");
    // A text to a business's client: the business's own subaccount, or none.
    // This preferred the PLATFORM number until 2026-10-06.
    const { endCustomerSmsSender } = await import("@/lib/twilio-credentials.server");
    const sender = await endCustomerSmsSender(client.organization_id);
    if (!sender) throw new Error(NO_TEXTING_YET);
    const notifyFrom = sender.from;
    const kindEnabled =
      data.kind === "reminder" ? org.notify_sms_visit_reminder : org.notify_sms_visit_completed;
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
      const r = await sendTwilioSms({
        to: destPhone,
        body,
        from: sender.from ?? undefined,
        messagingServiceSid: sender.messagingServiceSid ?? undefined,
        credentials: sender.credentials,
      });
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

/** "On my way", by text when it can go and by email when it cannot. The
 *  button on a stop sends it every time it is pressed; tapping Navigate sends
 *  it once per visit, and only when the owner has turned that on. */
export const sendOnMyWayMessage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        trigger: z.enum(["button", "navigate"]),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { sendOnMyWay } = await import("@/lib/on-my-way.server");
    const r = await sendOnMyWay({
      supabase: context.supabase,
      userId: context.userId,
      visitId: data.visitId,
      trigger: data.trigger,
    });
    // The button is a person asking for it to be sent, so a refusal is
    // theirs to see. Navigate is a side effect of opening a map and says
    // nothing when it declines.
    if (!r.sent && data.trigger === "button") {
      throw new Error(`"On my way" was not sent (${r.reason}).`);
    }
    return r;
  });
