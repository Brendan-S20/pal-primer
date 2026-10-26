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
  /** The access box's placeholder (#527). Its label is the same on every
   *  line, "Gate code or access notes"; what to put in it is not. */
  accessPlaceholder: string;
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
    accessPlaceholder: "Gate code, which gate, where the dogs are during the visit…",
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
    accessPlaceholder: "Gate or door code, where the key or lockbox is, where the leash is…",
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
    accessPlaceholder: "Door code, where the key or lockbox is, alarm, parking…",
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
    accessPlaceholder: "Where the van can park, gate code, who will hand over your pet…",
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
    accessPlaceholder: "Gate code, where to park, where to meet…",
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
    accessPlaceholder: "Gate code, where the key is, parking…",
    cadences: RECURRING,
    metaDescription:
      "Enter your ZIP and number of pets to get a price, then start service online or ask for a quote.",
    noun: "pet care",
  },
};

/** The line the page speaks for: the service picked, else the business's
 *  only service, else pet waste (a business that lists nothing online is
 *  the zone-priced scooping form it always was). */
export function bookingLine(
  services: readonly PublicService[],
  chosen: PublicService | null,
): ServiceLine {
  if (chosen) return chosen.service_line;
  if (services.length === 1) return services[0].service_line;
  return "pet_waste";
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
