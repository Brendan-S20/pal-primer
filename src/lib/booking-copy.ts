/** What the booking link says, per service line (#525).
 *
 *  /signup/{slug} was written for one service: pricing a yard. Every word on
 *  it, from the meta description to the "Charged today" sentence, assumed a
 *  scooping business, so a walk read as a cleanup. This is the one map the
 *  page reads its line-dependent words from: the step 1 hint, the quote
 *  panel's labels, the "Charged today" sentence,
 *  the note's placeholder, the pet field, the cadences, and the meta
 *  description.
 *
 *  Pet waste reads exactly as it did before the map existed, apart from the
 *  per-visit billing sentence #528 rewrote for every line. The yard questions
 *  themselves ("When was your yard last cleaned?", the first cleanup line)
 *  are not words here: whether they are ASKED is asksAboutTheYard's answer
 *  (lib/public-services.ts), and the form gates them on it.
 *
 *  Pure, so the form, the route's head and the tests read one copy. English
 *  only: anything a customer reads speaks the business's language (CLAUDE.md,
 *  "What stays English on purpose"). */

import { PORTAL_FREQUENCY_VALUES } from "@/lib/frequency-request";
import type { PublicService } from "@/lib/public-services";
import type { ServiceLine } from "@/lib/service-lines";

export type Cadence = (typeof PORTAL_FREQUENCY_VALUES)[number];

export type BookingCopy = {
  /** The pet field's label. "Dogs" only for a dog-only line. */
  petLabel: "Dogs" | "Pets";
  /** Step 1's hint, before the button's name: "... then hit Get instant price." */
  priceHint: string;
  /** One visit, as the quote panel and the billing sentence name it. */
  visit: string;
  /** Several of them. */
  visits: string;
  /** The "Anything else?" placeholder. */
  notePlaceholder: string;
  /** The second box on each pet's row (#527): what tells THIS business
   *  something. A groomer prices a coat; a scooper only wants a size. */
  breedLabel: string;
  /** The access box's label. A gate code is a yard's; a sitter needs the
   *  door (#560). */
  accessLabel: string;
  /** The access box's placeholder (#527). */
  accessPlaceholder: string;
  /** The line under the headline, when the owner's own words are about a
   *  yard and this line has none (#560). */
  intro: string;
  /** The cadences offered, in the order the select lists them. All of them
   *  are recurring: the public signup provisions a subscription, so a
   *  one-time option needs a one-off path from the webhook first. */
  cadences: readonly Cadence[];
  /** The meta description for a business that sells this line alone. */
  metaDescription: string;
  /** How the line reads in a list ("pet waste removal or dog walking"). */
  noun: string;
};

const RECURRING = PORTAL_FREQUENCY_VALUES;

export const BOOKING_COPY: Readonly<Record<ServiceLine, BookingCopy>> = {
  pet_waste: {
    petLabel: "Dogs",
    priceHint: "Enter your ZIP and dogs, then hit",
    visit: "visit",
    visits: "visits",
    notePlaceholder: "Gate code, dog names, preferred days…",
    breedLabel: "Breed or size",
    accessLabel: "Gate code or access notes",
    accessPlaceholder: "Gate code, which gate, where the dogs are during the visit…",
    intro: "Tell us about your property and pets and we'll get you a quote.",
    cadences: RECURRING,
    metaDescription:
      "Enter your ZIP, number of dogs, and cleanup frequency to get a price, then start service online or ask for a quote.",
    noun: "pet waste removal",
  },
  dog_walking: {
    petLabel: "Dogs",
    priceHint: "Enter your ZIP and dogs, then hit",
    visit: "walk",
    visits: "walks",
    notePlaceholder: "Dog names, how to get in, preferred days and times…",
    breedLabel: "Breed or size",
    accessLabel: "Door or gate code, or access notes",
    accessPlaceholder: "Gate or door code, where the key or lockbox is, where the leash is…",
    intro: "Tell us about your dogs and when you'd like walks, and we'll get you a price.",
    cadences: ["weekly", "twice_weekly", "biweekly", "monthly"],
    metaDescription:
      "Enter your ZIP, number of dogs, and how often you'd like walks to get a price, then start service online or ask for a quote.",
    noun: "dog walking",
  },
  pet_sitting: {
    petLabel: "Pets",
    priceHint: "Enter your ZIP and pets, then hit",
    visit: "visit",
    visits: "visits",
    notePlaceholder: "Pet names, feeding and medication, how to get in…",
    breedLabel: "Breed or size",
    accessLabel: "Door code or access notes",
    accessPlaceholder: "Door code, where the key or lockbox is, alarm, parking…",
    intro: "Tell us about your pets and the dates you need, and we'll get you a price.",
    cadences: ["weekly", "twice_weekly", "biweekly", "monthly"],
    metaDescription:
      "Enter your ZIP, number of pets, and how often you'd like visits to get a price, then start service online or ask for a quote.",
    noun: "pet sitting",
  },
  mobile_grooming: {
    petLabel: "Pets",
    priceHint: "Enter your ZIP and pets, then hit",
    visit: "groom",
    visits: "grooms",
    notePlaceholder: "Pet names, breed and coat, where the van can park…",
    breedLabel: "Breed and coat",
    accessLabel: "Parking and access notes",
    accessPlaceholder: "Where the van can park, gate code, who will hand over your pet…",
    intro: "Tell us about your pets and we'll price the groom.",
    cadences: ["monthly", "biweekly"],
    metaDescription:
      "Enter your ZIP, number of pets, and how often you'd like grooming to get a price, then start service online or ask for a quote.",
    noun: "mobile grooming",
  },
  training: {
    petLabel: "Dogs",
    priceHint: "Enter your ZIP and dogs, then hit",
    visit: "session",
    visits: "sessions",
    notePlaceholder: "Dog names, what you'd like to work on, preferred days…",
    breedLabel: "Breed and age",
    accessLabel: "Where to meet, or access notes",
    accessPlaceholder: "Gate code, where to park, where to meet…",
    intro: "Tell us about your dog and what you'd like to work on, and we'll get you a price.",
    cadences: ["weekly", "biweekly"],
    metaDescription:
      "Enter your ZIP, number of dogs, and how often you'd like sessions to get a price, then start service online or ask for a quote.",
    noun: "dog training",
  },
  other: {
    petLabel: "Pets",
    priceHint: "Enter your ZIP and pets, then hit",
    visit: "visit",
    visits: "visits",
    notePlaceholder: "Pet names, how to get in, preferred days…",
    breedLabel: "Breed or size",
    accessLabel: "Access notes",
    accessPlaceholder: "Gate code, where the key is, parking…",
    intro: "Tell us about your pets and we'll get you a price.",
    cadences: RECURRING,
    metaDescription:
      "Enter your ZIP and number of pets to get a price, then start service online or ask for a quote.",
    noun: "pet care",
  },
};

/** The line the page speaks for: the service picked, else the business's
 *  only service, else pet waste when the business sells it (a pet-waste
 *  business that lists nothing online is the zone-priced scooping form it
 *  always was). A business that runs no pet waste speaks for its own first
 *  line instead (#560): a walker whose walks are not priced yet, or whose
 *  visitor has not picked between a walk and a sit, is not asked about a
 *  yard. `orgLines` is what the business runs; omitted, pet waste. */
export function bookingLine(
  services: readonly PublicService[],
  chosen: PublicService | null,
  orgLines: readonly ServiceLine[] = ["pet_waste"],
): ServiceLine {
  if (chosen) return chosen.service_line;
  if (services.length === 1) return services[0].service_line;
  const offered = services.length > 0 ? services.map((s) => s.service_line) : orgLines;
  if (offered.length === 0 || offered.includes("pet_waste")) return "pet_waste";
  return offered[0];
}

/** The lines a booking page's description speaks for: the ones it lists
 *  online, else, for a business that runs no pet waste, the ones it runs
 *  (#560), so it is not described as a scooping form. A pet-waste business
 *  that lists nothing reads as it always did. */
export function bookingPageLines(
  listed: readonly ServiceLine[],
  orgLines: readonly ServiceLine[] = [],
): ServiceLine[] {
  if (listed.length > 0) return [...listed];
  return orgLines.includes("pet_waste") ? [] : [...orgLines];
}

/** The services a booking page names under its headline (#560), so its first
 *  screen says what the business does: "Dog walking and pet sitting". Null
 *  when it lists nothing online. */
export function bookingServicesLine(lines: readonly ServiceLine[]): string | null {
  const nouns = [...new Set(lines)].map((l) => BOOKING_COPY[l].noun);
  if (nouns.length === 0) return null;
  const list =
    nouns.length === 1
      ? nouns[0]
      : `${nouns.slice(0, -1).join(", ")} and ${nouns[nouns.length - 1]}`;
  return list.charAt(0).toUpperCase() + list.slice(1);
}

/** The cadence actually used: the one picked when the line offers it, else
 *  the line's first. A visitor who picked Weekly for a walk and then switched
 *  to grooming is not sent a cadence the grooming list never showed. */
export function bookingCadence(line: ServiceLine, picked: string): Cadence {
  const offered = BOOKING_COPY[line].cadences;
  return (offered as readonly string[]).includes(picked) ? (picked as Cadence) : offered[0];
}

/** "After today, you pay $30.00 per walk as walks happen. Cancel anytime." (#528) */
export function perVisitBillingSentence(line: ServiceLine, perVisit: string): string {
  const c = BOOKING_COPY[line];
  return `After today, you pay ${perVisit} per ${c.visit} as ${c.visits} happen. Cancel anytime.`;
}

/** What "Charged today" covers, after the amount. */
export function chargedTodayCovers(line: ServiceLine, withFirstCleanup: boolean): string {
  const v = BOOKING_COPY[line].visit;
  return withFirstCleanup
    ? `, which covers your first cleanup plus your first scheduled ${v}.`
    : `, which covers your first scheduled ${v}.`;
}

/** The page's meta description, from the lines the business sells online.
 *  One line (or none listed) is that line's own sentence; several name each. */
export function bookingMetaDescription(lines: readonly ServiceLine[]): string {
  const unique = [...new Set(lines)];
  if (unique.length <= 1) return BOOKING_COPY[unique[0] ?? "pet_waste"].metaDescription;
  const nouns = unique.map((l) => BOOKING_COPY[l].noun);
  const list = `${nouns.slice(0, -1).join(", ")} or ${nouns[nouns.length - 1]}`;
  return `Get a price for ${list}: pick a service and enter your ZIP and pets, then start service online or ask for a quote.`;
}

/** What the page says instead for a stay: a service priced per night, which
 *  is asked for rather than started (isRequestedAsAStay, #546). There is no
 *  Frequency select and no price, so these are the words that replace them:
 *  the dates go in the preferred start date (relabelled as the first night)
 *  and the note, and the office confirms the stay and its price. */
export const STAY_COPY = {
  /** Where the Frequency select would be. */
  howItWorks:
    "Stays are booked by request. Send your dates and we'll confirm the stay and its price.",
  /** The quote panel, before anything is sent. */
  panelHint:
    "Tell us your dates and pets and we'll get back to you to confirm your stay and its price.",
  /** The preferred start date's label. */
  startDateLabel: "First night",
  /** The "Anything else?" placeholder. */
  notePlaceholder: "Your last night, pet names, feeding and medication, how to get in…",
  /** The quote request's button. */
  requestButton: "Request this stay",
} as const;

/** Under the first night's date: who confirms it. */
export function stayStartDateHint(business: string): string {
  return `${business} will confirm your stay for on or after this date.`;
}

/** Words that only fit a yard. An owner's own intro that uses one ("Tell us
 *  about your yard and we'll get you a quote.") is right for pet waste and
 *  wrong for a sit, a walk, a groom or a lesson. */
const YARD_ONLY = /\b(yards?|lawns?|scoop\w*|poop|waste|clean-?ups?)\b/i;

/** The line under the headline for the service the visitor is looking at
 *  (#560): the owner's words, unless they talk about a yard and this line
 *  has none, in which case the line's own sentence. Pet waste always reads
 *  the owner's words, exactly as before. */
export function bookingIntro(ownerOrDefault: string, line: ServiceLine): string {
  if (line === "pet_waste" || !YARD_ONLY.test(ownerOrDefault)) return ownerOrDefault;
  return BOOKING_COPY[line].intro;
}

/** What the page says for a groom (#560): priced here, per pet size and with
 *  add-ons, and then either booked for a day and an open time and paid for,
 *  or sent as a request the office confirms a time for, with no charge. */
export const GROOM_COPY = {
  /** Under the price, before the usual billing sentence. */
  chargedTodayLead: "Charged today if you book:",
  /** Under the billing sentence: the other way in. */
  orRequest: "Or send a request without paying, and we'll confirm a time.",
  /** The booking button, where Start service would be. */
  bookButton: "Book and pay",
  /** The quote request's button. */
  requestButton: "Request this groom",
  /** The size question's label, per pet. */
  sizeLabel: "Size",
  /** Under the size question. */
  sizeHint: "The groom is priced by each pet's size.",
  /** The day's label, where Preferred start date would be. */
  dayLabel: "Groom date",
  /** After the day's and the time's labels. */
  toBook: "(to book)",
  /** Under the day. */
  dayHint: "Pick a day to see open times. A request can leave this empty.",
  /** The time's label. */
  timeLabel: "Start time",
  timePlaceholder: "Pick a time",
  timeNeedsPrice: "Get your price first, then pick a time.",
  timeNeedsDay: "Pick a day first.",
  timeLoading: "Finding open times…",
  timeHint: "Times are when the van arrives.",
  /** Under Book and pay, once everything else is in. */
  pickTime: "Pick a day and a start time to book.",
} as const;

/** What the page says for a service with no online price yet (#560): it is
 *  still listed, so a visitor can ask for it, and the office sends the
 *  price. */
export const UNPRICED_COPY = {
  /** The quote request's button. */
  requestButton: "Request a quote",
} as const;

/** The quote panel's hint when the page is a request with no price on it:
 *  a service with no price yet, or a business that does not price online.
 *  A pet-waste page asks about the property, as it always did; any other
 *  line asks about the dogs or pets it serves (#560). */
export function requestPanelHint(line: ServiceLine): string {
  if (line === "pet_waste")
    return "Tell us about your property and pets and we'll get back to you with a price.";
  return `Tell us about your ${BOOKING_COPY[line].petLabel.toLowerCase()} and we'll get back to you with a price.`;
}

/** The price line's label for one visit. A groom is requested, not started,
 *  so it reads "Each groom" rather than "Ongoing" (#560). */
export function perVisitLineLabel(line: ServiceLine, requested: boolean): string {
  if (!requested) return "Ongoing";
  const v = BOOKING_COPY[line].visit;
  return `Each ${v}`;
}

/** The add-ons' heading and hint. With no price yet, the add-ons ride the
 *  request and the price comes with the quote (#560). */
export const ADD_ON_COPY = {
  legend: "Add-ons",
  hint: (visit: string) => `Each add-on is added to every ${visit}.`,
  unpricedHint: "Your add-ons go with your request. We'll send the full price with your quote.",
} as const;
