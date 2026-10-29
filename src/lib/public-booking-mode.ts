/** How the public booking link starts a service (#574): the owner's setting
 *  on each service, services.public_booking_mode.
 *
 *    one_time      one visit, charged once. No cadence, no repeating plan.
 *    recurring     a cadence, prepaid per visit: the plan the link always sold.
 *    package       a set of sessions at the package's price (service_packages).
 *    request_only  no Start service and no card: the link asks for a quote.
 *
 *  Pure, so Settings, the public form, the server functions and the tests read
 *  one copy. Nothing here, or anywhere the mode is read, looks at a service's
 *  NAME: the mode is the only switch. */

import type { ServiceLine } from "@/lib/service-lines";
import type { PriceUnit } from "@/lib/services";

export const PUBLIC_BOOKING_MODES = ["one_time", "recurring", "package", "request_only"] as const;
export type PublicBookingMode = (typeof PUBLIC_BOOKING_MODES)[number];

/** The modes a visitor can pay for on the link. */
export type StartedBookingMode = Exclude<PublicBookingMode, "request_only">;

export function isPublicBookingMode(v: unknown): v is PublicBookingMode {
  return typeof v === "string" && (PUBLIC_BOOKING_MODES as readonly string[]).includes(v);
}

/** The mode a new service gets when nobody chose one. The same rule as the
 *  database's tg_services_public_booking_mode (20261029150000): a stay is
 *  asked for (#546), a training session is one visit, the rest repeat. */
export function defaultPublicBookingMode(
  line: ServiceLine,
  priceUnit: PriceUnit,
): PublicBookingMode {
  if (priceUnit === "night") return "request_only";
  if (line === "training") return "one_time";
  return "recurring";
}

/** A service's package, as the link sells it. */
export type PublicPackage = {
  id: string;
  name: string;
  sessions_count: number;
  price_cents: number;
};

/** What the database row says, read back: an unknown or NULL mode is
 *  request_only, and a package mode with no package that can be sold is
 *  request_only too, so a half-set service is a quote request rather than a
 *  card taken for nothing. */
export function storedPublicBookingMode(
  raw: unknown,
  pack: PublicPackage | null | undefined,
): PublicBookingMode {
  if (!isPublicBookingMode(raw)) return "request_only";
  if (raw === "package" && !(pack && pack.price_cents > 0 && pack.sessions_count > 0))
    return "request_only";
  return raw;
}

/** The mode the form acts on. `undefined` is a database the mode column has
 *  not reached yet (the migration is applied after this code is live), which
 *  is the link as it was: recurring. */
export function effectivePublicBookingMode(
  s: { booking_mode?: PublicBookingMode | null } | null | undefined,
): PublicBookingMode {
  if (!s) return "recurring";
  if (s.booking_mode === undefined) return "recurring";
  return s.booking_mode ?? "request_only";
}

/** Settings → Services: each mode's name and what it does, in the owner's
 *  words. */
export const PUBLIC_BOOKING_MODE_COPY: Record<PublicBookingMode, { label: string; hint: string }> =
  {
    one_time: {
      label: "One visit",
      hint: "A client pays once and gets one visit. Nothing repeats.",
    },
    recurring: {
      label: "Repeating plan",
      hint: "A client picks how often and pays for each visit ahead.",
    },
    package: {
      label: "Package",
      hint: "A client pays the package price once and books the sessions it includes.",
    },
    request_only: {
      label: "Request only",
      hint: "No online payment. Your booking link asks for a quote instead.",
    },
  };

/** Settings → Services: the heading over the choice. */
export const PUBLIC_BOOKING_MODE_LEGEND = "On your booking link";

/** What a package-mode service with no package chosen says in Settings. */
export const PACKAGE_NEEDED = "Pick the package your booking link sells, or choose another option.";

/** What creating a package-mode service says: the package is made for a
 *  service that already exists. */
export const PACKAGE_AFTER_CREATE =
  "Add the service first, then set up its package and choose it here.";

/** The public form's words for a service that is not a repeating plan. */
export const ONE_TIME_COPY = {
  /** Where the Frequency select would be. */
  howItWorks: "One visit. You pay once for this session.",
  /** The price line's label. */
  lineLabel: "This session",
  /** Under the price. */
  chargedTodayLead: "Charged today if you book:",
  chargedOnce: "You're charged once for this session. Nothing repeats.",
  startButton: "Book and pay",
} as const;

export const PACKAGE_COPY = {
  howItWorks: (sessions: number) =>
    `A package of ${sessions} session${sessions === 1 ? "" : "s"}. You pay once and we schedule each one with you.`,
  lineLabel: (name: string, sessions: number) =>
    `${name} (${sessions} session${sessions === 1 ? "" : "s"})`,
  chargedTodayLead: "Package total charged today:",
  sessionsTracked: (sessions: number) =>
    `Covers ${sessions} session${sessions === 1 ? "" : "s"}. We keep count of the sessions you have left.`,
  startButton: "Buy package",
} as const;

/** The line on the Stripe charge, the invoice and the lead. */
export function startedChargeDescription(
  mode: StartedBookingMode,
  serviceName: string | null,
  pack: { name: string; sessions_count: number } | null,
): string {
  const svc = serviceName?.trim() || "Service";
  if (mode === "package" && pack)
    return `${pack.name}: ${svc} (${pack.sessions_count} session${pack.sessions_count === 1 ? "" : "s"})`;
  if (mode === "one_time") return `${svc}, one visit`;
  return svc;
}
