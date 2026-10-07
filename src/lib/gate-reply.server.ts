import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { textsTo, type SentText } from "@/lib/platform-replies";

/** The dogs-secured handshake: a client answers "on my way" with ENT (the dogs
 *  are in, come in) or DNE (do not enter).
 *
 *  The reply arrives on the number the "on my way" text went from, which is
 *  the business's OWN number: customer texts never go from HoundStack's
 *  toll-free number (lib/twilio-credentials.server). So this is asked from
 *  the business's path in routes/api/public/hooks/twilio.ts, scoped to that
 *  business, and the reply is in its name. It used to live in the platform
 *  number's handler, when "on my way" went from there.
 *
 *  It applies only to a visit this business texted that phone about in the
 *  last day, that is today's, and that is unstarted or under way. */

const DAY_MS = 86_400_000;

export async function answerGateReply(p: {
  supabaseAdmin: any;
  orgId: string;
  phone: string;
  kind: "enter" | "do_not_enter";
  tz: string | null;
  brand: string;
  contact: string;
  now?: Date;
}): Promise<string> {
  const now = p.now ?? new Date();
  const { data: sentRows } = await p.supabaseAdmin
    .from("messages")
    .select("organization_id, client_id, visit_id, to_number, created_at")
    .eq("organization_id", p.orgId)
    .eq("direction", "outbound")
    .gte("created_at", new Date(now.getTime() - DAY_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(500);
  const recent = textsTo((sentRows ?? []) as SentText[], p.phone).find((m) => m.visit_id);

  const noMatch = `${p.brand}: We couldn't match that to a visit today. Please contact ${p.contact}.`;
  if (!recent?.visit_id) return noMatch;

  const { data: visit } = await p.supabaseAdmin
    .from("visits")
    .select("id, organization_id, status, scheduled_on, clients(display_name)")
    .eq("id", recent.visit_id)
    .eq("organization_id", p.orgId)
    .maybeSingle();
  if (
    !visit ||
    !["scheduled", "in_progress"].includes(visit.status) ||
    visit.scheduled_on !== orgToday(p.tz || DEFAULT_ORG_TIMEZONE, now)
  ) {
    return noMatch;
  }

  await p.supabaseAdmin
    .from("visits")
    .update({ gate_reply: p.kind, gate_reply_at: now.toISOString() })
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
