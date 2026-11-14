// HoundStack's own directory of pet pros (#630, phase 1). Every profile is a
// HoundStack customer that opted in, and shows only what its owner confirmed
// when they did.
//
// Kept pure (no server import) so the pages, the settings screen and the tests
// can all read it. The database half is
// supabase/migrations/20261110120000_a-pet-owner-can-find-compare-and-ask-a-business-that-opted-in.sql.
//
// Phase 1: opt-in profiles, search by service + ZIP, compare up to three,
// request a quote. Reviews, held for moderation, are in lib/directory-reviews.ts.

import { SERVICE_LINE_LABEL, type ServiceLine } from "@/lib/service-lines";
import { DIRECTORY_REF } from "@/lib/directory-site";
import type { PublicBookingMode } from "@/lib/public-booking-mode";

/** The lines a visitor can search for. `other` is accepted by the database
 *  but means nothing to a visitor, so it is never offered as a search. */
export const DIRECTORY_SEARCH_LINES = [
  "pet_waste",
  "dog_walking",
  "pet_sitting",
  "mobile_grooming",
  "training",
] as const satisfies readonly ServiceLine[];
export type DirectorySearchLine = (typeof DIRECTORY_SEARCH_LINES)[number];

/** What a visitor calls each line. Plainer than Settings' labels. */
export const DIRECTORY_LINE_LABEL: Record<DirectorySearchLine, string> = {
  pet_waste: "Pet waste removal",
  dog_walking: "Dog walking",
  pet_sitting: "Pet sitting",
  mobile_grooming: "Mobile grooming",
  training: "Dog training",
};

export function directoryLineLabel(line: string): string {
  return (
    (DIRECTORY_LINE_LABEL as Record<string, string>)[line] ??
    (SERVICE_LINE_LABEL as Record<string, string>)[line] ??
    line
  );
}

export function isDirectorySearchLine(v: unknown): v is DirectorySearchLine {
  return typeof v === "string" && (DIRECTORY_SEARCH_LINES as readonly string[]).includes(v);
}

/** Compare is up to three, as the spec says and the database enforces. */
export const MAX_COMPARE = 3;

/** One service as a visitor reads it. */
export type DirectoryService = {
  label: string;
  service_line: string;
  /** The owner's confirmed price-from, or null: "ask for a quote". */
  price_from_cents: number | null;
  price_unit: string | null;
};

/** The public shape, column for column what directory_search and
 *  directory_profiles_by_slug return. No organization id, no address, no
 *  phone, no email: none of those exist on this type, by design. */
export type DirectoryProfile = {
  slug: string;
  display_name: string;
  logo_url: string | null;
  bio: string | null;
  service_lines: string[];
  coverage_zips: string[];
  coverage_cities: string[];
  services: DirectoryService[];
  published_at: string | null;
};

/** The sentence every directory page carries (FTC 16 CFR 465.6 territory, and
 *  plain honesty): who is listed and why. Also says what we are not. */
export const DIRECTORY_DISCLOSURE =
  "Every pro here runs their business on HoundStack and chose to be listed. " +
  "Profiles show only what each business confirmed. No paid placement.";

/** A ZIP as the search takes it: five digits, or null. */
export function cleanZip(raw: unknown): string | null {
  const s = typeof raw === "string" ? raw.trim() : "";
  return /^\d{5}$/.test(s) ? s : null;
}

/** The slugs a compare URL names, cleaned, deduplicated, at most three. */
export function compareSlugs(raw: unknown): string[] {
  const parts =
    typeof raw === "string" ? raw.split(",") : Array.isArray(raw) ? raw.map(String) : [];
  const out: string[] = [];
  for (const p of parts) {
    const s = p.trim().toLowerCase();
    if (!isDirectorySlug(s) || out.includes(s)) continue;
    out.push(s);
    if (out.length === MAX_COMPARE) break;
  }
  return out;
}

/** The database's slug rule (directory_profiles_slug_check). */
export function isDirectorySlug(s: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{1,58}[a-z0-9])$/.test(s);
}

/** A suggested slug from a business name. The owner can change it. */
export function slugFromName(name: string): string {
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return s.length >= 3 ? s : `${s || "pro"}-pets`.slice(0, 60);
}

/** "From $22 / visit", or "Ask for a quote". */
export function priceFromLabel(
  s: Pick<DirectoryService, "price_from_cents" | "price_unit">,
): string {
  if (s.price_from_cents == null) return "Ask for a quote";
  const dollars = s.price_from_cents / 100;
  const amount = Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
  const unit = s.price_unit && s.price_unit !== "flat" ? ` / ${s.price_unit}` : "";
  return `From ${amount}${unit}`;
}

/** The lowest confirmed price-from on a line, for the compare table. */
export function lowestPriceFrom(
  p: DirectoryProfile,
  line?: string | null,
): DirectoryService | null {
  const priced = p.services.filter(
    (s) => s.price_from_cents != null && (!line || s.service_line === line),
  );
  if (!priced.length) return null;
  return priced.reduce((a, b) => ((b.price_from_cents ?? 0) < (a.price_from_cents ?? 0) ? b : a));
}

/** Where a profile works, in words: its cities, then how many ZIPs. */
export function coverageLabel(
  p: Pick<DirectoryProfile, "coverage_cities" | "coverage_zips">,
): string {
  const cities = p.coverage_cities.slice(0, 4).join(", ");
  const more = p.coverage_cities.length > 4 ? ` and ${p.coverage_cities.length - 4} more` : "";
  const zips = p.coverage_zips.length;
  const zipWord = `${zips} ZIP code${zips === 1 ? "" : "s"}`;
  return cities ? `${cities}${more} (${zipWord})` : zipWord;
}

// ── The head of every directory page ─────────────────────────────────────

/**
 * Every directory route sets its OWN robots tag and a self-canonical, rather
 * than leaning on the root's app-wide noindex: when a city is switched on for
 * search engines, it is this function, not __root.tsx, that changes.
 *
 * `indexable` is the per-city INDEXABLE flag. It is off everywhere for now
 * and nothing passes `true` (tests/a-directory-shows-only-what-the-owner-published.test.ts
 * pins that); turning a city on is a separate, deliberate change. There is
 * NO minimum number of businesses per city for listing: every business that
 * opts in is listed and searchable (Brendan, 2026-11-09: "list as many
 * businesses as possible"). The flag is only about search engines.
 */
export function directoryHead(input: {
  title: string;
  description: string;
  /** The page's own path, e.g. `/pros/acme-scoop`. */
  path: string;
  origin: string;
  indexable?: false;
}): {
  meta: Array<Record<string, string | undefined>>;
  links: Array<{ rel: string; href: string }>;
} {
  const url = `${input.origin}${input.path}`;
  return {
    meta: [
      { title: input.title },
      { name: "description", content: input.description },
      { name: "robots", content: input.indexable ? "index, follow" : "noindex, follow" },
      { property: "og:site_name", content: "HoundStack" },
      { property: "og:title", content: input.title },
      { property: "og:description", content: input.description },
      { property: "og:url", content: url },
    ],
    links: [{ rel: "canonical", href: url }],
  };
}

// ── The quote request ────────────────────────────────────────────────────

/** `leads.source` for a quote from the directory. */
export const DIRECTORY_LEAD_SOURCE = "directory" as const;

export type DirectoryQuoteForm = {
  name: string;
  email: string;
  phone: string;
  zip: string;
  service_line: string;
  dog_count: string;
  message: string;
};

/** The body /api/public/leads takes for a directory quote. The business is
 *  named by its DIRECTORY slug; the server resolves it to the business only
 *  if the profile is published. The line asked about is told to the office
 *  in the message, since a visitor picks a line, not one of the business's
 *  own service ids. */
export function directoryQuoteBody(directorySlug: string, f: DirectoryQuoteForm) {
  const dogs = f.dog_count.trim() === "" ? undefined : Number(f.dog_count);
  const line = f.service_line ? directoryLineLabel(f.service_line) : "";
  const asked = line ? `Asked about: ${line}.` : "";
  const message = [asked, f.message.trim(), "Sent from the HoundStack directory."]
    .filter(Boolean)
    .join("\n\n");
  return {
    directory_slug: directorySlug,
    name: f.name.trim(),
    email: f.email.trim(),
    phone: f.phone.trim(),
    location: f.zip.trim(),
    dog_count: dogs != null && Number.isFinite(dogs) ? dogs : undefined,
    message,
    source: DIRECTORY_LEAD_SOURCE,
  };
}

/** How long a second quote from the same email to the same business is the
 *  same quote (merged, not a second lead). */
export const DIRECTORY_QUOTE_MERGE_HOURS = 24;

// ── Profile content: tagline, highlights, business areas (directory v2 5a) ──
// The database half is
// supabase/migrations/20261112090000_a-directory-profile-says-what-a-business-is-and-where.sql;
// these limits are its CHECKs, so the form can say no before the server does.

export const DIRECTORY_TAGLINE_MAX = 90;
export const DIRECTORY_HIGHLIGHTS_MAX = 4;
export const DIRECTORY_HIGHLIGHT_MAX = 40;
export const DIRECTORY_AREAS_MAX = 8;
export const DIRECTORY_AREA_NAME_MAX = 40;

/** A named group of the ZIPs a profile already covers. */
export type DirectoryArea = { name: string; zips: string[] };

/** A listed service's package, as the view shows it: never its id. */
export type DirectoryPackage = { name: string; sessions_count: number; price_cents: number };

/** One element of directory_public_listings.services: the four keys every
 *  directory reader shares, plus what 20261112100000 adds (directory v2 step 7). */
export type DirectoryListedService = DirectoryService & {
  /** The EFFECTIVE mode: request_only unless the business can sell this
   *  service online right now (directoryBookingMode below). */
  booking_mode: PublicBookingMode;
  /** Opaque, for /d/{slug}/book?service=<key>. Not a service id. */
  booking_key: string;
  /** Only when booking_mode is package. */
  package: DirectoryPackage | null;
};

/** One row of directory_public_listings: the public profile, plus the three
 *  columns 20261112090000 adds to the view and the three 20261112100000 adds
 *  after them. */
export type DirectoryListing = Omit<DirectoryProfile, "services"> & {
  services: DirectoryListedService[];
  tagline: string | null;
  highlights: string[];
  areas: DirectoryArea[];
  /** At least one listed service can be booked online now. */
  books_online: boolean;
  /** The owner's own cancellation and refund policy, or null. */
  booking_policy_text: string | null;
  /** `/d/{slug}/book` when books_online, else null. */
  book_path: string | null;
};

/**
 * The allowlist. A public reader keeps these keys and drops everything else,
 * whatever the database returns; the contract tests hold the view's columns,
 * the proof's expected keys and these lists to each other. Adding a public
 * field is a change to this list first.
 */
export const PUBLIC_LISTING_FIELDS = [
  "slug",
  "display_name",
  "logo_url",
  "bio",
  "service_lines",
  "coverage_zips",
  "coverage_cities",
  "services",
  "published_at",
  "tagline",
  "highlights",
  "areas",
  "books_online",
  "booking_policy_text",
  "book_path",
] as const satisfies readonly (keyof DirectoryListing)[];
export const PUBLIC_SERVICE_FIELDS = [
  "label",
  "service_line",
  "price_from_cents",
  "price_unit",
  "booking_mode",
  "booking_key",
  "package",
] as const satisfies readonly (keyof DirectoryListedService)[];
export const PUBLIC_PACKAGE_FIELDS = [
  "name",
  "sessions_count",
  "price_cents",
] as const satisfies readonly (keyof DirectoryPackage)[];
export const PUBLIC_AREA_FIELDS = [
  "name",
  "zips",
] as const satisfies readonly (keyof DirectoryArea)[];

/** Spaces collapsed and trimmed, as set_directory_profile stores text. */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Highlights as the database keeps them: one line each, blanks and repeats
 *  (any case) dropped, order kept. */
export function cleanHighlights(raw: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const h = oneLine(r);
    if (!h || seen.has(h.toLowerCase())) continue;
    seen.add(h.toLowerCase());
    out.push(h);
  }
  return out;
}

export type DirectoryContentInput = {
  tagline: string;
  highlights: readonly string[];
  areas: readonly DirectoryArea[];
  /** The profile's coverage: every area ZIP must be one of these. */
  coverageZips: readonly string[];
};

/** Problems with the tagline, highlights and areas, worded for the owner.
 *  `where` says which field, so the form can put each one beside it. Empty
 *  when the database would accept them. */
export function directoryContentProblems(
  v: DirectoryContentInput,
): Array<{ where: "tagline" | "highlights" | `area-${number}` | "areas"; message: string }> {
  const out: ReturnType<typeof directoryContentProblems> = [];
  const tagline = oneLine(v.tagline);
  if (tagline.length > DIRECTORY_TAGLINE_MAX) {
    out.push({
      where: "tagline",
      message: `Keep the tagline to ${DIRECTORY_TAGLINE_MAX} characters (it is ${tagline.length}).`,
    });
  }
  const highlights = cleanHighlights(v.highlights);
  if (highlights.length > DIRECTORY_HIGHLIGHTS_MAX) {
    out.push({
      where: "highlights",
      message: `List up to ${DIRECTORY_HIGHLIGHTS_MAX} highlights.`,
    });
  }
  const long = highlights.find((h) => h.length > DIRECTORY_HIGHLIGHT_MAX);
  if (long) {
    out.push({
      where: "highlights",
      message: `Keep each highlight to ${DIRECTORY_HIGHLIGHT_MAX} characters: "${long.slice(0, 20)}…" is ${long.length}.`,
    });
  }
  if (v.areas.length > DIRECTORY_AREAS_MAX) {
    out.push({ where: "areas", message: `A profile has at most ${DIRECTORY_AREAS_MAX} areas.` });
  }
  const covered = new Set(v.coverageZips);
  const names = new Set<string>();
  v.areas.forEach((a, i) => {
    const where = `area-${i}` as const;
    const name = oneLine(a.name);
    if (!name) out.push({ where, message: "Give this area a name." });
    else if (name.length > DIRECTORY_AREA_NAME_MAX)
      out.push({
        where,
        message: `Keep the area name to ${DIRECTORY_AREA_NAME_MAX} characters (it is ${name.length}).`,
      });
    else if (names.has(name.toLowerCase()))
      out.push({ where, message: `Another area is already called "${name}".` });
    names.add(name.toLowerCase());
    if (!a.zips.length) out.push({ where, message: "Pick at least one ZIP code for this area." });
    const outside = a.zips.filter((z) => !covered.has(z));
    if (outside.length)
      out.push({
        where,
        message: `Not in the ZIP codes you cover: ${outside.join(", ")}. Add them above, or untick them here.`,
      });
  });
  return out;
}

// ── Booking exposure (directory v2 step 7) ────────────────────────────────
// The database half is
// supabase/migrations/20261112100000_a-directory-listing-says-which-services-book-online.sql.

/** organizations.booking_policy_text's CHECK. */
export const BOOKING_POLICY_MAX = 400;

/** The policy as set_directory_booking stores it: trimmed, empty is null. */
export function cleanBookingPolicy(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim();
  return t ? t : null;
}

/** The business's three gates. Every one has to be on. */
export type DirectoryBookingGates = {
  /** organizations.directory_booking_enabled: the owner's directory switch. */
  directoryBookingEnabled: boolean;
  /** organizations.public_signup_enabled: "Accept signups online". */
  publicSignupEnabled: boolean;
  /** organizations.stripe_connect_charges_enabled, synced from Stripe. */
  chargesEnabled: boolean;
};

/** A listed service, as the rules need to see it. */
export type DirectoryBookingService = {
  active: boolean;
  service_line: string;
  base_price_cents: number | null;
  /** services.public_booking_mode as stored (NULL or junk reads request_only). */
  public_booking_mode: unknown;
  /** The platform lets a visitor book this line (platform_service_lines). */
  lineBookable: boolean;
  /** The package public_package_id names, if it is this service's. */
  pack?: { active: boolean; sessions_count: number; price_cents: number } | null;
};

/**
 * The EFFECTIVE booking mode the directory shows for one listed service. The
 * same rule as the view's CASE in 20261112100000, and the contract test
 * holds the two to each other:
 *
 *   request_only unless the switch, public signup AND Stripe charges are on,
 *   and the service is active, on a bookable line, priced (or zone-priced
 *   pet waste), and stored as one_time / recurring, or package with a
 *   package on sale (sessions and price above zero). A groom is never a
 *   package. The directory app never decides this itself; it reads it.
 */
export function directoryBookingMode(
  gates: DirectoryBookingGates,
  s: DirectoryBookingService,
): PublicBookingMode {
  if (!(gates.directoryBookingEnabled && gates.publicSignupEnabled && gates.chargesEnabled))
    return "request_only";
  if (!s.active || !s.lineBookable) return "request_only";
  if (!(s.service_line === "pet_waste" || s.base_price_cents != null)) return "request_only";
  if (s.public_booking_mode === "one_time" || s.public_booking_mode === "recurring")
    return s.public_booking_mode;
  if (
    s.public_booking_mode === "package" &&
    s.service_line !== "mobile_grooming" &&
    s.pack &&
    s.pack.active &&
    s.pack.sessions_count > 0 &&
    s.pack.price_cents > 0
  )
    return "package";
  return "request_only";
}

/** What the server's hand-off lookup (directory_booking_handoff) answers. */
export type DirectoryHandoff = {
  signup_slug: string;
  service_id: string | null;
  booking_mode: string;
  books_online: boolean;
};

/**
 * Where /d/{directory slug}/book sends a visitor: the business's own booking
 * link with the service and ZIP filled in and `ref` saying it came from the
 * directory. `book=1` only when the lookup says this service can be sold now;
 * without it the booking link asks for a quote and offers no card (the
 * request path), whatever the business's link would otherwise do.
 */
export function directoryBookingHref(h: DirectoryHandoff, zip: string | null): string {
  const q = new URLSearchParams();
  if (h.service_id) q.set("service", h.service_id);
  if (zip) q.set("zip", zip);
  q.set("ref", DIRECTORY_REF);
  if (h.books_online && h.service_id && h.booking_mode !== "request_only") q.set("book", "1");
  return `/signup/${encodeURIComponent(h.signup_slug)}?${q.toString()}`;
}

/** The booking link's own reading of those params: came from the directory,
 *  and may it sell. Anything but the exact values reads as no. */
export function directoryBookingSearch(search: Record<string, unknown>): {
  fromDirectory: boolean;
  /** From the directory and not cleared to sell: ask for a quote only. */
  quoteOnly: boolean;
  serviceId: string | null;
  zip: string | null;
} {
  const fromDirectory = search.ref === DIRECTORY_REF;
  const book = search.book === 1 || search.book === "1";
  const sid = typeof search.service === "string" ? search.service : "";
  const zip = cleanZip(typeof search.zip === "number" ? String(search.zip).padStart(5, "0") : search.zip);
  return {
    fromDirectory,
    quoteOnly: fromDirectory && !book,
    serviceId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid) ? sid : null,
    zip,
  };
}
