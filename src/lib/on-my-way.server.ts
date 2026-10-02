import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { etaPhrase, onMyWayText, shouldSendOnNavigate, techFirstName } from "@/lib/on-my-way";
import { trackingUrl } from "@/lib/live-tracking";

/** Tell a customer their tech is on the way: by text when a text can go,
 *  otherwise by email.
 *
 *  The text used to be the only channel, and it refused any client with no
 *  texting consent on file, which on day one is every imported client. So the
 *  order here is a preference, not a gate: each refusal on the SMS side
 *  (turned off, no consent, opted out, on hold, no sender, no phone, or the
 *  carrier said no) falls through to email, and the result says which went.
 *
 *  `supabase` is the CALLER's client. Reading the visit through it is the
 *  access check: a tech who cannot see the visit cannot announce it. Only the
 *  `on_my_way_sent_at` stamp is written with the service role, because the
 *  column is bookkeeping about a message, not a change a tech makes to a
 *  visit. */

export type OnMyWayResult =
  { sent: true; channel: "sms" | "email" } | { sent: false; reason: string };

export async function sendOnMyWay(opts: {
  supabase: SupabaseClient<any>;
  userId: string;
  visitId: string;
  trigger: "button" | "navigate";
  now?: Date;
}): Promise<OnMyWayResult> {
  const { supabase, userId, visitId, trigger } = opts;
  const now = opts.now ?? new Date();

  const { data: v, error } = await supabase
    .from("visits")
    .select(
      "id, organization_id, client_id, status, scheduled_on, eta_start, eta_end, on_my_way_sent_at, tracking_token, clients(display_name, primary_phone, sms_opt_out, comms_paused), properties(street, city, visit_contact_name, visit_contact_phone, visit_contact_email)",
    )
    .eq("id", visitId)
    .single();
  if (error || !v) throw new Error(error?.message ?? "Visit not found");

  const { data: org } = await supabase
    .from("organizations")
    .select(
      "name, timezone, sms_from_number, notify_sms_on_my_way, notify_email_on_my_way, on_my_way_on_navigate, live_tracking_enabled",
    )
    .eq("id", v.organization_id)
    .single();
  if (!org) throw new Error("Organization not found");
  const tz = org.timezone || DEFAULT_ORG_TIMEZONE;

  if (trigger === "navigate") {
    const check = shouldSendOnNavigate({
      enabled: org.on_my_way_on_navigate === true,
      status: v.status,
      scheduledOn: v.scheduled_on,
      orgToday: orgToday(tz, now),
      sentAt: v.on_my_way_sent_at,
    });
    if (!check.send) return { sent: false, reason: check.reason };
  }

  const client = (Array.isArray(v.clients) ? v.clients[0] : v.clients) as {
    display_name: string | null;
    primary_phone: string | null;
    sms_opt_out: boolean | null;
    comms_paused: boolean | null;
  } | null;
  const prop = (Array.isArray(v.properties) ? v.properties[0] : v.properties) as {
    street: string | null;
    city: string | null;
    visit_contact_name: string | null;
    visit_contact_phone: string | null;
    visit_contact_email: string | null;
  } | null;
  // Same rule as the other visit texts (P3.5): the property's own contact,
  // when it has one, is who is waiting at the gate.
  const customerName = prop?.visit_contact_phone
    ? (prop.visit_contact_name ?? "there")
    : (client?.display_name ?? "there");

  const { data: staff } = await supabase
    .from("staff")
    .select("id, display_name")
    .eq("user_id", userId)
    .eq("organization_id", v.organization_id)
    .maybeSingle();
  const techName = techFirstName(staff?.display_name);
  const eta = etaPhrase(v.eta_start, v.eta_end, tz, now);
  // The live map, only when the business has turned it on. Off, and the
  // text and email are exactly what they were before it existed.
  const trackUrl =
    org.live_tracking_enabled === true
      ? trackingUrl(await ensureTrackingToken(visitId, v.tracking_token))
      : null;

  const sms = await trySms({
    supabase,
    org,
    visit: v,
    client,
    destPhone: prop?.visit_contact_phone || client?.primary_phone || null,
    staffId: staff?.id ?? null,
    body: onMyWayText({
      customerName,
      orgName: org.name ?? "your service",
      techName,
      eta,
      trackUrl,
    }),
  });

  let result: OnMyWayResult;
  if (sms.ok) {
    result = { sent: true, channel: "sms" };
  } else {
    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
    const address = prop ? [prop.street, prop.city].filter(Boolean).join(", ") : undefined;
    const r = await enqueueAppEmail({
      organizationId: v.organization_id,
      clientId: v.client_id,
      templateName: "on-my-way",
      notifyKey: "notify_email_on_my_way",
      // One per visit per day from the automatic path; the button is a
      // person deciding to say it again, so it gets a fresh key.
      idempotencyKey:
        trigger === "navigate" ? `on-my-way-${visitId}` : `on-my-way-${visitId}-${now.getTime()}`,
      toOverride: prop?.visit_contact_email || undefined,
      templateData: {
        techName: techName ?? undefined,
        eta: eta ?? undefined,
        address,
        trackUrl: trackUrl ?? undefined,
      },
      manual: trigger === "button",
    });
    result = r.ok
      ? { sent: true, channel: "email" }
      : { sent: false, reason: `text: ${sms.reason}; email: ${r.reason}` };
  }

  if (result.sent) {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin
      .from("visits")
      .update({ on_my_way_sent_at: now.toISOString() })
      .eq("id", visitId);
  }
  return result;
}

/** The visit's tracking token, minted on first use. One per visit, kept
 *  across re-sends, so a customer holding the first text's link still has a
 *  working map after the button is pressed again. Written with the service
 *  role, like on_my_way_sent_at: it is bookkeeping about a message. */
async function ensureTrackingToken(visitId: string, existing: string | null): Promise<string> {
  if (existing) return existing;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const minted = crypto.randomUUID();
  await supabaseAdmin
    .from("visits")
    .update({ tracking_token: minted })
    .eq("id", visitId)
    .is("tracking_token", null);
  // Whoever won a race, the stored one is the link.
  const { data } = await supabaseAdmin
    .from("visits")
    .select("tracking_token")
    .eq("id", visitId)
    .single();
  return (data?.tracking_token as string | null) ?? minted;
}

async function trySms(p: {
  supabase: SupabaseClient<any>;
  org: { sms_from_number: string | null; notify_sms_on_my_way: boolean | null };
  visit: { id: string; organization_id: string; client_id: string };
  client: { sms_opt_out: boolean | null; comms_paused: boolean | null } | null;
  destPhone: string | null;
  staffId: string | null;
  body: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!p.org.notify_sms_on_my_way) return { ok: false, reason: "turned off" };
  if (!p.destPhone) return { ok: false, reason: "no phone" };
  if (p.client?.sms_opt_out) return { ok: false, reason: "opted out" };
  if (p.client?.comms_paused) return { ok: false, reason: "on hold" };
  const { data: mayText, error } = await (p.supabase as any).rpc("client_may_be_texted", {
    _client_id: p.visit.client_id,
  });
  if (error || !mayText) return { ok: false, reason: "no consent" };
  const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
  const from = platformTwilioFrom() ?? p.org.sms_from_number ?? null;
  if (!from) return { ok: false, reason: "no sender" };

  const { sendTwilioSms } = await import("@/lib/twilio.server");
  let sid: string | null = null;
  let status = "queued";
  let err: string | null = null;
  try {
    const r = await sendTwilioSms({ from, to: p.destPhone, body: p.body });
    sid = r.sid;
    status = r.status || "sent";
  } catch (e: any) {
    err = e?.message ?? String(e);
    status = "failed";
  }
  await p.supabase.from("messages").insert({
    organization_id: p.visit.organization_id,
    client_id: p.visit.client_id,
    visit_id: p.visit.id,
    staff_id: p.staffId,
    direction: "outbound",
    body: p.body,
    from_number: from,
    to_number: p.destPhone,
    twilio_sid: sid,
    status: status as any,
    error: err,
  });
  return err ? { ok: false, reason: "carrier refused" } : { ok: true };
}
