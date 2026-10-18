// Which unit a business reads its distances in (#496).
//
// Storage is kilometres everywhere (see measures.ts). What a person reads
// depends on where the business is: a pet-waste business in Michigan reads
// "1.0 mi", one in Ontario reads "1.6 km". The business's own country is the
// answer when it is known (`organizations.country`, set in Settings >
// Business and by the setup guide). When it is not:
//
//   1. the browser's region, from `navigator.language` ("en-US" is US, "en-GB"
//      is GB, a bare "en" maximizes to US), because the person reading is
//      usually in the same country as the business they work for;
//   2. the business's currency: dollars read miles;
//   3. kilometres, which is what the rest of the world reads.
//
// Miles for the US and the inhabited US territories, km for every other
// country, as #496 specifies. The United Kingdom signs its roads in miles
// and is still km here; adding "GB" to MILES_COUNTRIES is the whole change
// if that is ever wanted.

import type { DistanceUnit } from "@/lib/measures";

/** Countries (ISO 3166-1 alpha-2) whose road distances are in miles. */
export const MILES_COUNTRIES: ReadonlySet<string> = new Set(["US", "PR", "GU", "VI", "AS", "MP"]);

export type DistanceUnitOrg = {
  country?: string | null;
  currency?: string | null;
};

function isCountryCode(v: string | null | undefined): v is string {
  return typeof v === "string" && /^[A-Z]{2}$/.test(v.trim().toUpperCase());
}

/** The region of a BCP 47 locale ("en-US" is "US"), or null. SSR safe: no
 *  `navigator` is read here, and a malformed tag is null rather than a throw. */
export function localeRegion(locale: string | null | undefined): string | null {
  if (!locale) return null;
  try {
    const region = new Intl.Locale(locale).maximize().region;
    return region && /^[A-Z]{2}$/.test(region) ? region : null;
  } catch {
    return null;
  }
}

function browserLocale(): string | null {
  if (typeof navigator === "undefined") return null;
  return navigator.language || null;
}

/**
 * "mi" or "km" for a business.
 *
 * `opts.locale` stands in for the browser's language: pass a tag to decide
 * for that locale, `null` to decide with no locale at all, or leave it out
 * to read `navigator.language` (none on the server).
 */
export function orgDistanceUnit(
  org: DistanceUnitOrg | null | undefined,
  opts: { locale?: string | null } = {},
): DistanceUnit {
  const country = org?.country;
  if (isCountryCode(country)) {
    return MILES_COUNTRIES.has(country.trim().toUpperCase()) ? "mi" : "km";
  }
  const region = localeRegion(opts.locale !== undefined ? opts.locale : browserLocale());
  if (region) return MILES_COUNTRIES.has(region) ? "mi" : "km";
  if ((org?.currency ?? "").trim().toLowerCase() === "usd") return "mi";
  return "km";
}

const US_STATES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY";
const US_TERRITORIES = "PR|GU|VI|AS|MP";
const CA_PROVINCES = "AB|BC|MB|NB|NL|NS|NT|NU|ON|PE|QC|SK|YT";

const US_TAIL = new RegExp(
  `\\b(${US_STATES}|${US_TERRITORIES})\\s+\\d{5}(?:-\\d{4})?\\s*(?:,?\\s*(?:USA|US|United States|United States of America)\\.?)?\\s*$`,
);
const CA_TAIL = new RegExp(
  `\\b(?:${CA_PROVINCES})\\s+[A-Z]\\d[A-Z]\\s?\\d[A-Z]\\d\\s*(?:,?\\s*Canada\\.?)?\\s*$`,
  "i",
);

/**
 * The country an address plainly says it is in, or null.
 *
 * Only the two shapes that cannot be mistaken: a US state or territory and a
 * ZIP at the end ("Austin, TX 78701", optionally ", USA"), and a Canadian
 * province and postal code ("Toronto, ON M5V 2T6"). Anything else is null,
 * and the caller leaves the country alone. Same patterns as the backfill in
 * 20261018120000_a-us-business-reads-its-stops-in-miles.sql.
 */
export function countryFromAddress(address: string | null | undefined): string | null {
  const a = (address ?? "").trim();
  if (!a) return null;
  const us = US_TAIL.exec(a);
  if (us) {
    const code = us[1];
    return US_TERRITORIES.split("|").includes(code) ? code : "US";
  }
  if (CA_TAIL.test(a)) return "CA";
  return null;
}

/** The short list Settings > Business offers. "Other" is null: the app then
 *  decides from the browser and the currency, as it did before the column. */
export const BUSINESS_COUNTRIES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "US", label: "United States" },
  { value: "CA", label: "Canada" },
  { value: "GB", label: "United Kingdom" },
  { value: "AU", label: "Australia" },
  { value: "IE", label: "Ireland" },
  { value: "NZ", label: "New Zealand" },
];
