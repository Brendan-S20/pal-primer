// HoundStack's own directory of pet pros (#630, phase 1). Not a listing on
// Angi or anywhere else: every profile is a HoundStack customer that opted in,
// and shows only what its owner confirmed when they did.
//
// Kept pure (no server import) so the pages, the settings screen and the tests
// can all read it. The database half is
// supabase/migrations/20261110120000_a-pet-owner-can-find-compare-and-ask-a-business-that-opted-in.sql.
//
// Phase 1: opt-in profiles, search by service + ZIP, compare up to three,
// request a quote. Reviews, held for moderation, are in lib/directory-reviews.ts.

import { SERVICE_LINE_LABEL, type ServiceLine } from "@/lib/service-lines";
import { PET_WASTE_SERVICE_NAME } from "@/lib/services";

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
  pet_waste: PET_WASTE_SERVICE_NAME,
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
  "Every business listed here is a HoundStack customer that chose to be listed. " +
  "Profiles show only what each business confirmed. HoundStack is not affiliated with Angi or any other directory, " +
  "and businesses do not pay for placement.";

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
