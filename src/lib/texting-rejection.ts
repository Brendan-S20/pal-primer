// #972: a rejected or stopped texting filing, in plain words, for the owner
// on Settings → Texting and for an admin on /platform/addons.
//
// A rejected filing used to leave the admin queue and live only in an email
// to admins, and the owner saw Twilio's own sentence with nothing about what
// to change. Twilio keeps a rejected toll-free verification editable, with
// priority review, until its edit_expiration (the resubmit-by date we store),
// so the queue sorts by that date and the owner is told what to fix.
//
// The advice for each code is Twilio's own, from its error pages, said in an
// owner's words and pointed at the field on our form that fixes it:
//   30482  https://www.twilio.com/docs/api/errors/30482  business email domain
//   30483  https://www.twilio.com/docs/api/errors/30483  contact is not a person
//   30493  https://www.twilio.com/docs/api/errors/30493  Terms page
//   30507  https://www.twilio.com/docs/api/errors/30507  opt-in vs use case
//   30527  https://www.twilio.com/docs/api/errors/30527  registration number /
//          legal name does not match the IRS record
// A reason whose words say the registration number or EIN does not match is
// read as the last, whatever its code.

import type { RegistrationStatus } from "@/lib/texting-registration";

/** Every status the admin queue lists. */
export const QUEUE_STATUSES = [
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "failed",
] as const satisfies readonly RegistrationStatus[];

/** Rejected or stopped: waiting on the owner to fix and resubmit, not on an
 *  admin to activate. */
export function needsOwnerFix(status: RegistrationStatus | string): boolean {
  return status === "rejected" || status === "failed";
}

export type RejectionAdvice = {
  /** Short, for the admin row and the owner's heading. */
  title: string;
  /** What to change, on this page, in plain words. */
  fix: string;
};

const ADVICE: Record<string, RejectionAdvice> = {
  "30482": {
    title: "Business email is not on your own domain",
    fix: "Carriers want an email address at your business's own website domain, like you@yourbusiness.com, not a Gmail, Yahoo or other free address. Change Business email below to one on the same domain as your website, then resubmit.",
  },
  "30483": {
    title: "The contact must be a real person",
    fix: "The authorized contact has to be a real person who can speak for the business, with their full first and last name, not a role like Admin or Office. Put your own name, email and mobile number in Authorized contact below, then resubmit.",
  },
  "30493": {
    title: "Your Terms page is missing what carriers look for",
    fix: "Your Terms page has to open without a login and say, for texts: that message and data rates may apply, how often messages are sent, and that replying STOP opts out. Add that to the page at the address in Terms page below (or fix the address), then resubmit.",
  },
  "30507": {
    title: "How clients agree does not match what you text about",
    fix: "Carriers compare the way clients agree to texts with what you say you text them about. Check that your booking page and website describe appointment, visit and billing texts, not marketing. If your own site asks clients to agree to something else, change it to match, then resubmit.",
  },
  registration: {
    title: "Your legal name and EIN do not match the IRS record",
    fix: "Enter the legal business name exactly as it appears on your IRS EIN letter (CP 575 or 147C), with no abbreviations and not your trading name, and check the EIN digit by digit. A brand new EIN can take up to two weeks to be recognised. Then resubmit.",
  },
};

/** What to fix for one rejection, or null when the code is not one we have
 *  advice for (the owner still sees Twilio's own reason). */
export function rejectionAdvice(
  code: string | null | undefined,
  reason: string | null | undefined,
): RejectionAdvice | null {
  const c = (code ?? "").trim();
  if (c === "30527") return ADVICE.registration;
  if (ADVICE[c]) return ADVICE[c];
  const r = (reason ?? "").toLowerCase();
  if (
    /registration number|\bein\b|tax id|business registration/.test(r) &&
    /match|invalid|incorrect|missing|could not be (validated|verified)/.test(r)
  ) {
    return ADVICE.registration;
  }
  return null;
}

/** The codes with advice, for tests and the PR's record. */
export const ADVISED_CODES = ["30482", "30483", "30493", "30507", "30527"] as const;

type Sortable = {
  status: RegistrationStatus | string;
  resubmitDeadline: string | null;
  submittedAt: string | null;
};

/**
 * Rejected and stopped filings first (#972 review: the queue says so, and a
 * stopped row has no deadline to sort it up), then within each group the
 * soonest resubmit deadline first (the ones a day's delay can lose), then by
 * when they were submitted, oldest first, as the queue was before.
 */
export function sortTextingQueue<T extends Sortable>(rows: readonly T[]): T[] {
  const t = (iso: string | null) => (iso ? new Date(iso).getTime() : Number.POSITIVE_INFINITY);
  return [...rows].sort((a, b) => {
    const fa = needsOwnerFix(a.status) ? 0 : 1;
    const fb = needsOwnerFix(b.status) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    const da = t(a.resubmitDeadline);
    const db = t(b.resubmitDeadline);
    if (da !== db) return da - db;
    return t(a.submittedAt) - t(b.submittedAt);
  });
}
