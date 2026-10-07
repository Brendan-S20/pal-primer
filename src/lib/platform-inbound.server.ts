import { verifyTwilioInbound } from "@/lib/twilio-inbound-auth.server";
import { classifyReply } from "@/lib/platform-replies";

/** A text sent TO HoundStack's toll-free number.
 *
 *  That number texts ACCOUNT HOLDERS only (lib/twilio-credentials.server), so
 *  whoever is texting it is an account holder or a stranger. It is never a
 *  business's client, and nothing here treats it as one: no business is looked
 *  up, no client record is touched, nothing is written to any business's
 *  messages, and no office is notified.
 *
 *  Until 2026-10-06 this did the opposite. Every automated text to a
 *  business's client went out from this number, so a reply was matched to the
 *  business that texted that phone last, logged into its conversation, and
 *  STOP opted the client out across every business. Customer texts now go
 *  from each business's own number, and replies to THAT number are handled by
 *  the business's own path in routes/api/public/hooks/twilio.ts, ENT and DNE
 *  included (lib/gate-reply.server).
 *
 *  What stays is what carriers require of any number: STOP, START and HELP
 *  are answered, in HoundStack's name, with a real support contact. Twilio's
 *  own opt-out list is what blocks further texts after a STOP on a toll-free
 *  number; the reply here is the confirmation. Anything else gets no reply,
 *  because an auto-reply to an arbitrary text is how two automated systems
 *  end up texting each other. */

export const PLATFORM_BRAND = "HoundStack";
export const PLATFORM_SUPPORT = "support@houndstack.com";

export const PLATFORM_REPLIES = {
  stop: `${PLATFORM_BRAND}: You are unsubscribed from HoundStack account messages and will receive no further texts from this number. Reply START to resubscribe or HELP for help.`,
  start: `${PLATFORM_BRAND}: You are resubscribed to HoundStack account messages. Msg & data rates may apply. Reply STOP to opt out or HELP for help.`,
  help: `${PLATFORM_BRAND}: Account messages for people who use HoundStack: sign-in codes, security alerts and billing notices. For help contact ${PLATFORM_SUPPORT}. Msg & data rates may apply. Reply STOP to opt out.`,
} as const;

export async function handlePlatformReply(p: {
  requestUrl: string;
  pathWithQuery: string;
  params: Record<string, string>;
  signature: string | null;
  from: string;
  to: string;
  body: string;
  sid: string | null;
}): Promise<{ status: 200 | 401; reply: string | null }> {
  // No business to check against: the platform's own signature (or the
  // shared secret, as a last resort) is the only thing that can pass.
  const auth = await verifyTwilioInbound({
    requestUrl: p.requestUrl,
    pathWithQuery: p.pathWithQuery,
    params: p.params,
    signature: p.signature,
    orgId: "",
  });
  if (!auth.ok) return { status: 401, reply: null };

  const kind = classifyReply(p.body);
  if (kind === "stop" || kind === "start" || kind === "help") {
    return { status: 200, reply: PLATFORM_REPLIES[kind] };
  }
  console.info("Inbound SMS to the platform number: not a keyword, not routed to any business");
  return { status: 200, reply: null };
}
