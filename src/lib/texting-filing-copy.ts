// #971: the words a business's toll-free verification is filed with, built
// from what that business actually runs.
//
// Until this the filing said every business was "a local service business",
// filed one visit-reminder sample, and named the booking link as the only
// way a client agrees to texts. Carriers check that the use-case summary,
// the samples and the opt-in match the business and that EVERY opt-in method
// is described (Twilio, "Collect business information": message_flow and
// message_samples), and a scooper, a walker and a groomer are not texting
// about the same thing.
//
// One builder, pure, for both places the text is read:
//   - Settings → Texting shows it to the owner before Submit, word for word
//   - lib/twilio-provisioning.server files it
// so what the owner reviewed is what Twilio receives. Unit tests pin the text
// for each line and for a mixed business
// (tests/the-filing-names-the-business-services.test.ts).
//
// The opt-in it describes is the one the product has (lib/client-sms-consent):
// the client portal, the public booking link, and a verbal yes the office
// records. Each stores the exact wording shown. A client imported from a
// spreadsheet has no consent row and is not texted (client_may_be_texted).

import { optInConfirmationText } from "@/lib/client-sms-consent";
import { pastDueInvoiceText, reviewAskText, STOP_LINE } from "@/lib/client-sms-templates";
import { onMyWayText, walkOnMyWayText } from "@/lib/on-my-way";
import { brandedBody } from "@/lib/sms-brand";
import { SERVICE_LINES, type ServiceLine } from "@/lib/service-lines";

/** What a client books, by line: plural for the summary, singular for a
 *  sample's [bracket]. "other" is accepted by the database but never offered. */
export const LINE_WORDS: Record<ServiceLine, { many: string; one: string }> = {
  pet_waste: { many: "yard cleanups", one: "yard cleanup" },
  dog_walking: { many: "walks", one: "walk" },
  pet_sitting: { many: "pet sits", one: "pet sit" },
  mobile_grooming: { many: "grooming appointments", one: "grooming appointment" },
  training: { many: "training sessions", one: "training session" },
  other: { many: "pet care visits", one: "visit" },
};

export { STOP_LINE };

/** The app's origin, from the portal link the filing already has: the
 *  live-map link is on the same host (lib/live-tracking). */
function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url.replace(/\/portal.*$/, "");
  }
}

export type FilingCopyInput = {
  /** The name every text starts with (organizations.name). */
  businessName: string;
  /** organizations.service_lines, in any order. */
  lines: readonly string[];
  /** The client portal's sign-in page for this business. */
  portalUrl: string;
  /** The public booking link, when the business has one. */
  bookingUrl: string | null;
  /** Where HELP points: the business email on the filing. */
  supportEmail: string;
  /** The business's website, the opt-in page of last resort. */
  websiteUrl: string;
  /** organizations.google_review_url: the link a review request carries. */
  googleReviewUrl?: string | null;
};

export type FilingCopy = {
  useCaseSummary: string;
  /** Three, each a real text (on the way, past due, review request) with
   *  [bracketed] values, starting with the business name and ending STOP. */
  samples: string[];
  /** What Twilio's single ProductionMessageSample field carries: every sample. */
  productionMessageSample: string;
  /** Every opt-in method, for the filing's AdditionalInformation. */
  optInDescription: string;
  /** optInDescription in its three parts, for the owner's review to show as
   *  a list: the sentence before the ways, the ways, the sentences after. */
  optInIntro: string;
  optInMethods: string[];
  optInOutro: string;
  /** Twilio's OptInType: the portal and the booking link are web forms; the
   *  verbal yes is described in optInDescription. */
  optInType: "WEB_FORM";
  /** Public pages a reviewer can open to see the consent wording: the
   *  booking link, whose form carries the checkbox. The portal's switch is
   *  behind a client's sign-in, so it is described rather than linked; with
   *  no booking link, the business's website, as before. */
  optInImageUrls: string[];
  optInConfirmationMessage: string;
  helpMessageSample: string;
};

/** The lines in a fixed order, unknown values dropped, pet waste for none. */
export function filingLines(lines: readonly string[]): ServiceLine[] {
  const known = SERVICE_LINES.filter((l) => lines.includes(l) && l !== "other");
  return known.length ? known : ["pet_waste"];
}

/** "a, b and c" */
export function listOf(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The client portal's link in a sample: what a real text carries after
 *  the portal's sign-in page, the client's own token in [brackets]. */
const linkIn = (base: string) => `${base}/[link]`;

/** The on-my-way text this business's clients get, from the real builders
 *  (lib/on-my-way), with the live-map link a business with live tracking
 *  sends (#971 review: "any link sent in real texts appears in a sample").
 *  A yard visit asks Dogs inside? ENT / DNE; a walk names the dogs; a sit, a
 *  groom or a lesson asks for a reply. A pet-waste business, mixed or not,
 *  files the yard's, because that is its two-way text. */
function onMyWaySample(name: string, lines: ServiceLine[], origin: string): string {
  const common = {
    customerName: "[client name]",
    orgName: name,
    techName: "[staff name]",
    eta: "between [time] and [time]",
    trackUrl: `${origin}/track/[link]`,
  };
  if (lines.includes("pet_waste")) return brandedBody(name, onMyWayText({ ...common, yard: true }));
  if (lines.length === 1 && lines[0] === "dog_walking")
    return brandedBody(name, walkOnMyWayText({ ...common, dogs: "[dog names]" }));
  return brandedBody(name, onMyWayText({ ...common, yard: false }));
}

export function filingCopy(i: FilingCopyInput): FilingCopy {
  const name = i.businessName.trim();
  const lines = filingLines(i.lines);
  const many = listOf(lines.map((l) => LINE_WORDS[l].many));
  const portal = i.portalUrl.replace(/\/+$/, "");
  const origin = originOf(portal);

  // Only what the business's number actually sends (#971 review): the
  // walk, sit and lesson reports go by email and push, and no "invoice
  // ready" text exists, so neither is claimed.
  const useCaseSummary =
    `${name} is a local pet care business that provides ${many}. It texts its own clients, ` +
    `who have opted in: visit reminders; on-the-way notices, with a live map link when live ` +
    `tracking is on${lines.includes("pet_waste") ? " and, for yard visits, a reply to say whether dogs are inside" : ""}; ` +
    `visit-complete confirmations; a request for a review after a completed visit, with a link ` +
    `to the business's Google review page; past-due invoice reminders and declined-card ` +
    `notices, with a link to the business's client portal; sign-in codes for that portal; and ` +
    `replies to their questions. No marketing.`;

  // Built from the texts themselves (lib/on-my-way, lib/client-sms-templates)
  // and started with the name the way every sender does (brandedBody).
  const samples = [
    onMyWaySample(name, lines, origin),
    brandedBody(
      name,
      pastDueInvoiceText({ name: "[client name]", amount: "[amount]", link: linkIn(portal) }),
    ),
    brandedBody(
      name,
      reviewAskText({
        template: null,
        orgName: name,
        firstName: "[first name]",
        link: i.googleReviewUrl?.trim() || "[Google review link]",
      }),
    ),
  ];

  const methods = [
    `(1) in the business's client portal (sign-in at ${portal}), by switching on texts on their Account page, beside the consent wording`,
    i.bookingUrl
      ? `(2) on the business's public booking page (${i.bookingUrl}), by ticking an unchecked box to receive texts when they book`
      : `(2) on the business's public booking page, by ticking an unchecked box to receive texts when they book`,
    `(3) by telling the business's staff yes in person or on the phone, which staff record in the business's account with the date and the exact wording read to the client`,
  ];
  const optInMethods = methods.map((m) => m.replace(/^\(\d\) /, ""));
  const optInIntro =
    `Clients agree to texts from ${name} in one of three ways, each showing or reading the ` +
    `business's name, the message types (appointments, visit updates and billing), "Message ` +
    `frequency varies", "Msg & data rates may apply", STOP and HELP, and links to the ` +
    `business's Terms and Privacy Policy before they agree`;
  const optInOutro =
    `Consent is optional and not a condition of purchase, and the exact wording each client ` +
    `agreed to is stored with the date. Clients imported from a spreadsheet or another system ` +
    `are not texted until they agree in one of these ways.`;
  const optInDescription = `${optInIntro}: ${methods.join("; ")}. ${optInOutro}`;

  return {
    useCaseSummary,
    samples,
    productionMessageSample: samples.join("\n"),
    optInDescription,
    optInIntro,
    optInMethods,
    optInOutro,
    optInType: "WEB_FORM",
    optInImageUrls: [i.bookingUrl || i.websiteUrl],
    optInConfirmationMessage: optInConfirmationText(name),
    helpMessageSample:
      `${name}: Service and account messages. For help contact ${i.supportEmail.trim()}. ` +
      `Msg & data rates may apply. ${STOP_LINE}`,
  };
}
