/** Reading an inbound text: what a reply asks for, and whose phone it is.
 *
 *  Named for where it started. Automated customer texts used to go out from
 *  HoundStack's PLATFORM number, and replies to it were matched to the
 *  business that texted that phone last. Since 2026-10-06 the platform number
 *  texts account holders only: a reply to it is answered in HoundStack's name
 *  and goes to no business (platform-inbound.server), while a reply to a
 *  business's own number, ENT and DNE included, is that business's
 *  (routes/api/public/hooks/twilio.ts, gate-reply.server). Both read replies
 *  with these. */

export type ReplyKind = "stop" | "start" | "help" | "enter" | "do_not_enter";

const STOP = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
const START = ["START", "YES", "UNSTOP"];
const HELP = ["HELP", "INFO"];
// The dogs-secured handshake operators already teach their customers:
// ENT, the dogs are in and the tech may enter; DNE, do not enter.
const ENTER = ["ENT", "ENTER", "OK TO ENTER"];
const DO_NOT_ENTER = ["DNE", "DO NOT ENTER", "DONT ENTER", "DON'T ENTER"];

/** What a reply asks for, or null for anything else (a question, a thank
 *  you), which goes to the office as an ordinary message. Matching is on the
 *  whole message, ignoring case and trailing punctuation, the way carriers
 *  match STOP: "Stop." is STOP, "stop by at noon" is not. */
export function classifyReply(body: string): ReplyKind | null {
  const t = body
    .trim()
    .toUpperCase()
    .replace(/[.!\s]+$/, "")
    .replace(/\s+/g, " ");
  if (STOP.includes(t)) return "stop";
  if (START.includes(t)) return "start";
  if (HELP.includes(t)) return "help";
  if (ENTER.includes(t)) return "enter";
  if (DO_NOT_ENTER.includes(t)) return "do_not_enter";
  return null;
}

export const digits = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "");

/** Two spellings of one US number, "+15125550100" and "(512) 555-0100",
 *  are the same phone. Compared on the last ten digits so a missing +1 does
 *  not make them strangers. */
export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = digits(a);
  const db = digits(b);
  if (da.length < 10 || db.length < 10) return da !== "" && da === db;
  return da.slice(-10) === db.slice(-10);
}

export type SentText = {
  organization_id: string;
  client_id: string | null;
  visit_id: string | null;
  to_number: string | null;
  created_at: string;
};

/** The texts sent to this phone, newest first. Callers pass texts already
 *  limited to one business and a time window. */
export function textsTo(sent: SentText[], phone: string): SentText[] {
  return sent
    .filter((m) => samePhone(m.to_number, phone))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
