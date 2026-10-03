import { verifyTwilioInbound } from "@/lib/twilio-inbound-auth.server";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { classifyReply, textsTo, type SentText } from "@/lib/platform-replies";

/** A reply to the PLATFORM number. See platform-replies.ts for why these
 *  used to vanish.
 *
 *  The business is the one whose text this phone most recently received from
 *  the platform number. STOP and START apply to every client record that was
 *  texted from it, across businesses, because the customer is opting out of
 *  the NUMBER, and every business's automated texts come from that number.
 *  ENT and DNE apply only to a visit that was texted about in the last day
 *  and is still today's, unstarted or under way. */

const DAY_MS = 86_400_000;

export async function handlePlatformReply(p: {
  requestUrl: string;
  pathWithQuery: string;
  params: Record<string, string>;
  signature: string | null;
  from: string;
  to: string;
  body: string;
  sid: string | null;
  now?: Date;
}): Promise<{ status: 200 | 401; reply: string | null }> {
  const now = p.now ?? new Date();
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // A year is the reach of STOP; the visit handshake below narrows to a day.
  const { data: sentRows } = await supabaseAdmin
    .from("messages")
    .select("organization_id, client_id, visit_id, to_number, created_at")
    .eq("direction", "outbound")
    .eq("from_number", p.to)
    .gte("created_at", new Date(now.getTime() - 365 * DAY_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(5000);
  const mine = textsTo((sentRows ?? []) as SentText[], p.from);
  const latest = mine[0] ?? null;

  const auth = await verifyTwilioInbound({
    requestUrl: p.requestUrl,
    pathWithQuery: p.pathWithQuery,
    params: p.params,
    signature: p.signature,
    orgId: latest?.organization_id ?? "",
  });
  if (!auth.ok) return { status: 401, reply: null };

  if (p.sid) {
    const { data: dup } = await supabaseAdmin
      .from("messages")
      .select("id")
      .eq("twilio_sid", p.sid)
      .limit(1)
      .maybeSingle();
    if (dup) return { status: 200, reply: null };
  }

  // A phone this number has never texted is not anybody's customer here.
  if (!latest) {
    console.warn("Inbound SMS to the platform number from a phone it never texted");
    return { status: 200, reply: null };
  }

  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("id, name, contact_email, contact_phone, timezone")
    .eq("id", latest.organization_id)
    .maybeSingle();
  const brand = org?.name?.trim() || "HoundStack";
  const contact =
    org?.contact_phone?.trim() || org?.contact_email?.trim() || "support@houndstack.com";

  await supabaseAdmin.from("messages").insert({
    organization_id: latest.organization_id,
    client_id: latest.client_id,
    visit_id: latest.visit_id,
    direction: "inbound",
    body: p.body,
    from_number: p.from,
    to_number: p.to,
    twilio_sid: p.sid,
    status: "received",
  });

  const kind = classifyReply(p.body);
  const clientIds = [...new Set(mine.map((m) => m.client_id).filter((x): x is string => !!x))];
  let reply: string | null = null;

  if (kind === "stop" || kind === "start") {
    if (clientIds.length) {
      await supabaseAdmin
        .from("clients")
        .update({ sms_opt_out: kind === "stop" })
        .in("id", clientIds);
    }
    reply =
      kind === "stop"
        ? `${brand}: You are unsubscribed and will receive no further messages. Reply START to resubscribe or HELP for help.`
        : `${brand}: You are resubscribed to service messages. Msg & data rates may apply. Reply STOP to opt out or HELP for help.`;
  } else if (kind === "help") {
    reply = `${brand}: Service and account messages. For help contact ${contact}. Msg & data rates may apply. Reply STOP to opt out.`;
  } else if (kind === "enter" || kind === "do_not_enter") {
    reply = await recordGateReply({
      supabaseAdmin,
      mine,
      kind,
      now,
      tz: org?.timezone || DEFAULT_ORG_TIMEZONE,
      brand,
      contact,
    });
  } else {
    // Anything else is a person writing to a business. Put it in front of
    // the office, the same as a reply to the business's own number.
    try {
      const { notifyRoles } = await import("@/lib/notify-center.server");
      await notifyRoles(["owner", "office_manager", "dispatcher"], {
        orgId: latest.organization_id,
        type: "inbound_sms",
        title: "New text needs a reply",
        body: `${p.from}: ${p.body.slice(0, 120)}`,
        link: "/messages",
      });
    } catch (e) {
      console.error("platform inbound notification failed", (e as Error).message);
    }
  }

  if (reply) {
    await supabaseAdmin.from("messages").insert({
      organization_id: latest.organization_id,
      client_id: latest.client_id,
      direction: "outbound",
      body: reply,
      from_number: p.to,
      to_number: p.from,
      status: "sent",
    });
  }
  return { status: 200, reply };
}

async function recordGateReply(p: {
  supabaseAdmin: any;
  mine: SentText[];
  kind: "enter" | "do_not_enter";
  now: Date;
  tz: string;
  brand: string;
  contact: string;
}): Promise<string> {
  const recent = p.mine.find(
    (m) => m.visit_id && Date.parse(m.created_at) > p.now.getTime() - DAY_MS,
  );
  const noMatch = `${p.brand}: We couldn't match that to a visit today. Please contact ${p.contact}.`;
  if (!recent?.visit_id) return noMatch;

  const { data: visit } = await p.supabaseAdmin
    .from("visits")
    .select("id, organization_id, status, scheduled_on, clients(display_name)")
    .eq("id", recent.visit_id)
    .maybeSingle();
  if (
    !visit ||
    !["scheduled", "in_progress"].includes(visit.status) ||
    visit.scheduled_on !== orgToday(p.tz, p.now)
  ) {
    return noMatch;
  }

  await p.supabaseAdmin
    .from("visits")
    .update({ gate_reply: p.kind, gate_reply_at: p.now.toISOString() })
    .eq("id", visit.id);

  if (p.kind === "do_not_enter") {
    try {
      const { notifyRoles } = await import("@/lib/notify-center.server");
      const who = (Array.isArray(visit.clients) ? visit.clients[0] : visit.clients)?.display_name;
      await notifyRoles(["owner", "office_manager", "dispatcher", "tech"], {
        orgId: visit.organization_id,
        type: "gate_do_not_enter",
        title: "Client says do not enter",
        body: `${who ?? "A client"} replied DNE to today's "on my way" text.`,
        link: "/my-day",
      });
    } catch (e) {
      console.error("DNE notification failed", (e as Error).message);
    }
    return `${p.brand}: Got it, we will not enter today. We'll be in touch about rescheduling.`;
  }
  return `${p.brand}: Thanks, your tech will know the dogs are secured.`;
}
