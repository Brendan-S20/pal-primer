// The words of the automated texts a business sends its clients, in one
// place (#971 review).
//
// Each sender builds its text here, and the toll-free filing
// (lib/texting-filing-copy) builds its sample texts from these same
// functions with [bracketed] values. Carriers compare a filing's samples with
// the live traffic, and the samples had drifted from it: they described a
// walk report text nobody sends, an "invoice ready" text that is really a
// past-due reminder, and left out the review request and the live-map link.
// One source means a change to a real text changes its sample with it
// (tests/the-filing-names-the-business-services.test.ts holds the senders
// to these functions).
//
// The on-my-way texts live in lib/on-my-way (onMyWayText, walkOnMyWayText)
// and are used the same way. Each body is passed through brandedBody by its
// sender, so a text starts with the business's name.

export const STOP_LINE = "Reply STOP to opt out.";

/** Messages → send a visit reminder (messages.functions). */
export function visitReminderText(p: { name: string; day: string }): string {
  return `Hi ${p.name}, this is a reminder your visit is scheduled for ${p.day}. ${STOP_LINE}`;
}

/** Messages → send a visit-complete confirmation (messages.functions). */
export function visitCompleteText(p: { name: string; day: string }): string {
  return `Hi ${p.name}, your visit is complete for ${p.day}. Thanks! ${STOP_LINE}`;
}

/** The nightly overdue-invoice reminder (hooks/nightly). It carried no STOP
 *  wording until the filing claimed every text does (#971 review). */
export function pastDueInvoiceText(p: { name: string; amount: string; link: string }): string {
  return `Hi ${p.name}, this is a friendly reminder that invoice for $${p.amount} is past due. Pay: ${p.link} ${STOP_LINE}`;
}

/** An automatic charge's declined card (hooks/stripe). Same STOP fix. */
export function cardDeclinedText(p: { name: string; link: string }): string {
  return `Hi ${p.name}, your card on file was declined. Please update your payment method: ${p.link} ${STOP_LINE}`;
}

/** The review request's default template, when the owner has not written
 *  their own (Settings → Reviews). {name} and {link} are filled per client. */
export function defaultReviewAskTemplate(orgName: string | null | undefined): string {
  return `Hi {name}, thanks for choosing ${orgName ?? "us"}! If we did a great job, a quick review would mean the world: {link} ${STOP_LINE}`;
}

/** The review request, from the owner's template or the default. */
export function reviewAskText(p: {
  template: string | null | undefined;
  orgName: string | null | undefined;
  firstName: string;
  link: string;
}): string {
  const template = (p.template ?? "").trim() || defaultReviewAskTemplate(p.orgName);
  return template.replace(/\{name\}/g, p.firstName).replace(/\{link\}/g, p.link);
}
