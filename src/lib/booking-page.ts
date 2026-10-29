/** Who the business is, where it works, and what its link says about it
 *  (#524, #526).
 *
 *  /signup/{slug} used to be previewed, titled and served as HoundStack's: a
 *  business texts its booking link and the unfurl reads "HoundStack: run your
 *  whole recurring pet service business from one app", over our logo. The
 *  page itself named the business and nothing else about it, and answered a
 *  ZIP outside every zone with "We'll price your yard ourselves", which never
 *  said the business might not work there.
 *
 *  Pure, so the route's head, the page and the tests read one copy. English
 *  only, like lib/booking-copy.ts: a customer reads the business's language. */

import { BOOKING_COPY, bookingMetaDescription } from "@/lib/booking-copy";
import type { ServiceLine } from "@/lib/service-lines";

/** The link preview image for a business with no logo: a plain card with a
 *  paw on it. No wordmark and no name of ours, for the reason
 *  TenantSignupShell gives ("I signed up with HoundStack, why is Bark Busters
 *  charging me?"). 1200x630, the size every unfurler crops to. */
export const NEUTRAL_PREVIEW_IMAGE = "/booking-preview.png";

/** The parts of a zone a stranger may see: the ZIPs it covers. Never its
 *  name (an office label like "MAIN") and never its prices. */
export type PublicZoneArea = {
  zip_codes?: readonly string[] | null;
  postal_prefix?: string | null;
  /** False for a zone the owner turned off (#449); it serves nobody new. */
  enabled?: boolean | null;
};

function joinAnd(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** How many ZIPs are listed by number before "and N more". */
const ZIPS_SHOWN = 4;

/** "Serving ZIP codes 78701, 78702 and 78704", from the business's zones.
 *  Null when no zone lists a ZIP or a prefix (a radius drawn on a map with
 *  no ZIPs filled in): the line hides rather than saying "Serving" nothing. */
export function serviceAreaSummary(all: readonly PublicZoneArea[]): string | null {
  const zones = all.filter((z) => z.enabled !== false);
  const zips = [
    ...new Set(
      zones
        .flatMap((z) => z.zip_codes ?? [])
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ].sort();
  const prefixes = [
    ...new Set(zones.map((z) => z.postal_prefix?.trim() ?? "").filter(Boolean)),
  ].sort();
  if (zips.length === 0 && prefixes.length === 0) return null;

  const parts: string[] = [];
  if (prefixes.length) {
    parts.push(
      `starting ${prefixes.length === 1 ? prefixes[0] : `${prefixes.slice(0, -1).join(", ")} or ${prefixes[prefixes.length - 1]}`}`,
    );
  }
  if (zips.length) {
    parts.push(
      zips.length <= ZIPS_SHOWN
        ? joinAnd(zips)
        : `${zips.slice(0, ZIPS_SHOWN - 1).join(", ")} and ${zips.length - (ZIPS_SHOWN - 1)} more`,
    );
  }
  const noun = prefixes.length === 0 && zips.length === 1 ? "ZIP code" : "ZIP codes";
  return `Serving ${noun} ${parts.join(", plus ")}`;
}

/** The honest answer to a ZIP no zone prices (#526). It says the business
 *  may not work there, so a visitor is not led through the whole form
 *  believing otherwise, and it keeps the quote request open: no dead ends. */
export function outOfAreaAnswer(businessName: string | null | undefined, zip: string): string {
  const who = businessName?.trim() || "This business";
  const where = zip.trim() || "that ZIP";
  return `${who} doesn't list ${where} in its service area yet. Leave your details and they'll let you know if they can help.`;
}

/** A phone number as a tap-to-call link: digits and a leading +, nothing a
 *  dialer would choke on. Null when there is nothing to dial. */
export function telHref(phone: string | null | undefined): string | null {
  const raw = phone?.trim() ?? "";
  const digits = raw.replace(/[^\d+]/g, "").replace(/(?!^)\+/g, "");
  return digits.replace(/\D/g, "").length >= 3 ? `tel:${digits}` : null;
}

/** What a link preview or a search result says about the page: the
 *  business's name and what it sells, not ours. */
export function bookingPageDescription(
  businessName: string | null | undefined,
  lines: readonly ServiceLine[],
): string {
  const unique = [...new Set(lines)];
  const sentence = bookingMetaDescription(unique);
  const name = businessName?.trim();
  if (!name) return sentence;
  // Several lines: the sentence already names each one.
  if (unique.length > 1) return `${name}. ${sentence}`;
  const noun = BOOKING_COPY[unique[0] ?? "pet_waste"].noun;
  return `${name} offers ${noun}. ${sentence}`;
}

export type BookingPageHeadInput = {
  /** The tab title, from customerTitle() in the route, which the
   *  every-tab-was-called-houndstack test holds every customer page to:
   *  "Riverbend Pet Services · Get a quote", the business first, so a tab
   *  strip that truncates from the right keeps the part that says whose it
   *  is. The preview's og:title is the same string. */
  title: string;
  /** Null when the business is not known: the lookup failed and the browser
   *  will ask again. The tags are then neutral, never ours. */
  name: string | null;
  logoUrl: string | null;
  /** The address the page answers on, which is the one to call canonical. */
  slug: string;
  lines: readonly ServiceLine[];
  /** appOrigin(), passed in so this stays pure. */
  origin: string;
};

type Meta = { title?: string; name?: string; property?: string; content?: string };

/** The route's `head` once the business is known. Every tag the root sets
 *  about HoundStack (title, description, og:*, twitter:*) is set again here,
 *  because HeadContent keeps the deepest route's tag for each name or
 *  property and the root's would otherwise show through.
 *
 *  `robots: noindex` is the one root tag left alone: whether a tenant's
 *  booking page should be indexed is the owner's call (see the PR for #524),
 *  and the preview does not depend on it. */
export function bookingPageHead(input: BookingPageHeadInput): {
  meta: Meta[];
  links: Array<{ rel: string; href: string }>;
} {
  const name = input.name?.trim() || null;
  const title = input.title;
  const description = bookingPageDescription(name, input.lines);
  const url = `${input.origin}/signup/${encodeURIComponent(input.slug)}`;
  const logo = input.logoUrl?.trim() || null;
  // A logo is usually small and square, so it previews as a thumbnail
  // ("summary"), and its size is not known here: the root's 1200x630 would
  // tell an unfurler to stretch it, so the size tags are emptied rather
  // than left saying something untrue.
  const image = logo ?? `${input.origin}${NEUTRAL_PREVIEW_IMAGE}`;
  const meta: Meta[] = [
    { title },
    { name: "description", content: description },
    { property: "og:site_name", content: name ?? undefined },
    { property: "og:type", content: "website" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: image },
    { property: "og:image:width", content: logo ? undefined : "1200" },
    { property: "og:image:height", content: logo ? undefined : "630" },
    { name: "twitter:card", content: logo ? "summary" : "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: image },
  ];
  return { meta, links: [{ rel: "canonical", href: url }] };
}

/** The head of a slug that names no business (the 404). Unbranded, like the
 *  page: a wrong link previews as "This page isn't available", not as
 *  HoundStack's own pitch, which is what the root's tags would say. */
export function unavailablePageHead(origin: string): { meta: Meta[] } {
  const title = "This page isn't available";
  const description = "Check the link with the business that sent it to you.";
  const image = `${origin}${NEUTRAL_PREVIEW_IMAGE}`;
  return {
    meta: [
      { title },
      { name: "description", content: description },
      { property: "og:site_name", content: undefined },
      { property: "og:title", content: title },
      { property: "og:description", content: description },
      { property: "og:url", content: undefined },
      { property: "og:image", content: image },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: title },
      { name: "twitter:description", content: description },
      { name: "twitter:image", content: image },
    ],
  };
}
