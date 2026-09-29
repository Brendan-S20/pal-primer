/** Replies to the texts HoundStack sends from its own number.
 *
 *  Automated texts (reminders, "on my way", payment alerts, login codes) go
 *  out from the PLATFORM number, shared by every business. The inbound webhook
 *  found a business by matching the number a reply was sent TO against
 *  `organizations.sms_from_number`, which the platform number is not, so a
 *  reply to an automated text matched nobody and was dropped with a warning.
 *  That included STOP: a customer who opted out was never marked opted out in
 *  the app.
 *
 *  A reply to a shared number says nothing about which business it is for,
 *  so it is matched to the most recent text that number sent to that phone.
 *  That is the conversation the customer is answering. */

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
 *  limited to the platform number and a time window. */
export function textsTo(sent: SentText[], phone: string): SentText[] {
  return sent
    .filter((m) => samePhone(m.to_number, phone))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}
