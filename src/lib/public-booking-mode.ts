/** How the public booking link starts a service (#574): the owner's answer,
 *  stored on services.public_booking_mode and set in Settings -> Services.
 *
 *    one_time      one visit, charged once, no repeating plan
 *    recurring     a cadence, prepaid per visit (how every service started
 *                  before this column existed)
 *    package       a training package: N sessions, the package price once
 *    request_only  a quote request only: no card, nothing provisioned
 *
 *  The link never decides by a service's NAME. An "Evaluation" is one_time
 *  because its row says so (the migration's backfill and the insert trigger
 *  default the training line to one_time), not because of the word.
 *
 *  Pure, so Settings, the form, the server functions, the webhook and the
 *  tests read one copy. Copy the visitor reads is English on purpose (a
 *  customer-facing page speaks the business's language). */

import type { ServiceLine } from "@/lib/service-lines";

export const PUBLIC_BOOKING_MODES = ["one_time", "recurring", "package", "request_only"] as const;
export type PublicBookingMode = (typeof PUBLIC_BOOKING_MODES)[number];

/** The modes that take a card. */
export type StartedBookingMode = Exclude<PublicBookingMode, "request_only">;

export function isPublicBookingMode(v: unknown): v is PublicBookingMode {
  return typeof v === "string" && (PUBLIC_BOOKING_MODES as readonly string[]).includes(v);
}

/** The package a `package` service sells, as the link shows it. */
export type PublicPackage = {
  id: string;
  name: string;
  sessions_count: number;
  price_cents: number;
};

export function parsePublicPackage(raw: unknown): PublicPackage | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.id !== "string" ||
    typeof o.name !== "string" ||
    typeof o.sessions_count !== "number" ||
    typeof o.price_cents !== "number" ||
    !Number.isInteger(o.sessions_count) ||
    o.sessions_count < 1 ||
    !Number.isInteger(o.price_cents) ||
    o.price_cents <= 0
  )
    return null;
  return {
    id: o.id,
    name: o.name,
    sessions_count: o.sessions_count,
    price_cents: o.price_cents,
  };
}

/** What a new service starts on when the owner has not chosen: the same rule
 *  as the database's insert trigger (services_public_booking_mode). A stay is
 *  asked for (#546); a training service is one session; everything else
 *  repeats, as it always did. */
export function defaultPublicBookingMode(line: ServiceLine, priceUnit: string): PublicBookingMode {
  if (priceUnit === "night") return "request_only";
  if (line === "training") return "one_time";
  return "recurring";
}

/** The mode the link acts on. A row with no answer is a request, never a
 *  guess. A package with no package to sell is a request too. A pet-waste
 *  business that lists nothing online names no service at all, and keeps
 *  the recurring signup it always had (`service` null). */
export function effectiveBookingMode(
  service: { booking_mode?: unknown; package?: PublicPackage | null } | null,
): PublicBookingMode {
  if (!service) return "recurring";
  const mode = isPublicBookingMode(service.booking_mode) ? service.booking_mode : "request_only";
  if (mode === "package" && !service.package) return "request_only";
  return mode;
}

/** What Settings says beside each choice. */
export const BOOKING_MODE_LABEL: Record<PublicBookingMode, string> = {
  one_time: "One visit",
  recurring: "Repeating plan",
  package: "Package of sessions",
  request_only: "Request a quote only",
};

export const BOOKING_MODE_HINT: Record<PublicBookingMode, string> = {
  one_time: "Clients pay once for one visit. Nothing repeats.",
  recurring: "Clients pick how often and prepay their first visit.",
  package: "Clients pay the package price once and get its sessions.",
  request_only: "Clients send a request. You reply with a price.",
};

/** How a service's row reads in the Settings list. */
export function bookingModeSummary(mode: unknown, packageName?: string | null): string {
  const m = isPublicBookingMode(mode) ? mode : "request_only";
  if (m === "package" && packageName) return `Booking link: ${packageName}`;
  return `Booking link: ${BOOKING_MODE_LABEL[m].toLowerCase()}`;
}

/** The frequency sent to public_quote for a mode with no cadence: weekly,
 *  whose multiplier is 1, so one session is priced at the service's own
 *  price. */
export const ONE_SESSION_FREQUENCY = "weekly" as const;

/** The words on the quote, by mode. `visit` is the line's word for one
 *  ("session", "walk"). */
export function oneTimeChargeSentence(visit: string): string {
  return `You're charged once for this ${visit}. Nothing repeats.`;
}

export function packageChargeSentence(sessions: number, visits: string, visit: string): string {
  return `You're charged once for the package. It includes ${sessions} ${
    sessions === 1 ? visit : visits
  }, and we track the ones you have left.`;
}

/** What the cadence select is replaced by, for a mode with no cadence. */
export function noCadenceNote(
  mode: PublicBookingMode,
  visit: string,
  visits: string,
  pkg: PublicPackage | null,
): string {
  if (mode === "package" && pkg)
    return `${pkg.name}: ${pkg.sessions_count} ${pkg.sessions_count === 1 ? visit : visits}.`;
  return `One ${visit}, booked once.`;
}

/** The last day of a package's weekly sessions, from the first: as many
 *  weeks as the package holds, so a package is never an open plan. */
export function packageSessionEnd(startsOn: string, sessions: number): string {
  const d = new Date(`${startsOn}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7 * Math.max(0, Math.floor(sessions) - 1));
  return d.toISOString().slice(0, 10);
}

/** The weekday of an ISO date, Sunday 0, as subscriptions.weekdays holds it. */
export function isoWeekday(iso: string): number {
  return new Date(`${iso}T00:00:00Z`).getUTCDay();
}

/** The day after an ISO date. */
export function nextIsoDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** How the webhook reads a signup row's mode: a row from before the column
 *  is the recurring signup it was sold as. */
export function signupBookingMode(raw: unknown): StartedBookingMode {
  return raw === "one_time" || raw === "package" ? raw : "recurring";
}
