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

export const STOP_LINE = "Reply STOP to opt out.";

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
};

export type FilingCopy = {
  useCaseSummary: string;
  /** Two or three, each starting with the business name and ending STOP. */
  samples: string[];
  /** What Twilio's single ProductionMessageSample field carries: every sample. */
  productionMessageSample: string;
  /** Every opt-in method, for the filing's AdditionalInformation. */
  optInDescription: string;
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

/** The second sample: the text a client gets on the day, in the line's words.
 *  A business with more than one line gets the on-the-way notice, which every
 *  line sends. */
function dayOfSample(name: string, lines: ServiceLine[], portal: string): string {
  if (lines.length > 1) {
    return `${name}: [Staff name] is on the way for your [service], arriving about [time]. ${STOP_LINE}`;
  }
  switch (lines[0]) {
    case "pet_waste":
      return `${name}: [Tech name] is on the way for your yard cleanup, arriving about [time]. ${STOP_LINE}`;
    case "dog_walking":
      return `${name}: [Walker name] finished [pet name]'s walk at [time]. See the walk report: ${portal}/[link] ${STOP_LINE}`;
    case "pet_sitting":
      return `${name}: [Sitter name] checked in on [pet name] at [time]. See the visit report: ${portal}/[link] ${STOP_LINE}`;
    case "mobile_grooming":
      return `${name}: [Groomer name] is on the way for [pet name]'s grooming appointment, arriving about [time]. ${STOP_LINE}`;
    case "training":
      return `${name}: [Trainer name] finished [pet name]'s training session. See the session notes: ${portal}/[link] ${STOP_LINE}`;
    default:
      return `${name}: [Staff name] is on the way, arriving about [time]. ${STOP_LINE}`;
  }
}

export function filingCopy(i: FilingCopyInput): FilingCopy {
  const name = i.businessName.trim();
  const lines = filingLines(i.lines);
  const many = listOf(lines.map((l) => LINE_WORDS[l].many));
  const one = lines.map((l) => LINE_WORDS[l].one).join(" / ");
  const portal = i.portalUrl.replace(/\/+$/, "");

  const useCaseSummary =
    `${name} is a local pet care business that provides ${many}. It texts its own clients, ` +
    `who have opted in, about their ${many}: reminders, on-the-way notices, ` +
    `visit updates and reports, their invoices and payments with a link to the business's ` +
    `client portal, sign-in codes for that portal, and replies to their questions. No marketing.`;

  const reminder =
    lines.length > 1
      ? `${name}: Reminder, your [${one}] is scheduled for [day, date] at [time]. ${STOP_LINE}`
      : `${name}: Reminder, your ${one} is scheduled for [day, date] at [time]. ${STOP_LINE}`;
  const invoice = `${name}: Your invoice for [amount] is ready. View and pay: ${portal}/[link] ${STOP_LINE}`;
  const samples = [reminder, dayOfSample(name, lines, portal), invoice];

  const methods = [
    `(1) in the business's client portal (sign-in at ${portal}), by switching on texts on their Account page, beside the consent wording`,
    i.bookingUrl
      ? `(2) on the business's public booking page (${i.bookingUrl}), by ticking an unchecked box to receive texts when they book`
      : `(2) on the business's public booking page, by ticking an unchecked box to receive texts when they book`,
    `(3) by telling the business's staff yes in person or on the phone, which staff record in the business's account with the date and the exact wording read to the client`,
  ];
  const optInDescription =
    `Clients agree to texts from ${name} in one of three ways, each showing or reading the ` +
    `business's name, the message types (appointments, visit updates and billing), "Message ` +
    `frequency varies", "Msg & data rates may apply", STOP and HELP, and links to the ` +
    `business's Terms and Privacy Policy before they agree: ${methods.join("; ")}. ` +
    `Consent is optional and not a condition of purchase, and the exact wording each client ` +
    `agreed to is stored with the date. Clients imported from a spreadsheet or another system ` +
    `are not texted until they agree in one of these ways.`;

  return {
    useCaseSummary,
    samples,
    productionMessageSample: samples.join("\n"),
    optInDescription,
    optInType: "WEB_FORM",
    optInImageUrls: [i.bookingUrl || i.websiteUrl],
    optInConfirmationMessage: optInConfirmationText(name),
    helpMessageSample:
      `${name}: Service and account messages. For help contact ${i.supportEmail.trim()}. ` +
      `Msg & data rates may apply. ${STOP_LINE}`,
  };
}
