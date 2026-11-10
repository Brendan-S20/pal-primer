// A picked place, turned into the parts an address form stores (#805).
//
// Live on 2026-11-09 (build a22d9e06): typing `2000 Brush St` on the new-client
// Property step offered `2000 Brush Street Detroit, MI, USA`, and picking it
// left City, State and ZIP blank — the field kept `2000 Brush St` as typed and
// the owner was stuck at "Please fill in Street, City, State, and ZIP".
//
// The pick was being refused, not half-applied. The provider mapped Google's
// `addressComponents` part by part with no second source, and the all-or-
// nothing rule from #783 (lib/address/pick.ts) then threw the whole place away
// the moment ONE part was missing. The part that goes missing in practice is
// the house number: a suggestion Google builds for a number it only knows by
// interpolation resolves to a place whose components describe the street —
// `route`, `locality`, `administrative_area_level_1`, `postal_code` — with no
// `street_number`. The same happens to a place with no `postal_code` component
// whose formatted address still carries the ZIP.
//
// So every part is read from the components first, then from the place's own
// formatted address, then — for the street line only — from the suggestion row
// the person actually picked. All three describe the SAME place; none of them
// is anything the person typed, so the #783 rule still holds: a pick supplies
// every part or the form keeps what was typed. `isCompletePick` is still the
// gate, and it still runs after this.
//
// Pure and client-safe, so the tests drive it with mocked Places payloads
// (vitest runs in node here, with no jsdom).
import type { AddressDetails } from "@/lib/address/provider.server";

/** One Places (New) address component. The legacy API's
 *  `long_name`/`short_name` are read too, so either payload maps. */
export interface PlaceComponent {
  longText?: string;
  shortText?: string;
  long_name?: string;
  short_name?: string;
  types?: string[];
}

export interface PlaceInput {
  addressComponents?: PlaceComponent[] | null;
  formattedAddress?: string | null;
  location?: { latitude?: number | null; longitude?: number | null } | null;
  /** The suggestion row the person picked, as it was shown to them. */
  suggestion?: { mainText?: string | null; secondaryText?: string | null } | null;
}

/** The parts a one-line address can be split into. Empty string = not found. */
export interface ParsedAddress {
  street: string;
  unit: string;
  city: string;
  region: string;
  postalCode: string;
}

const US_STATES: Record<string, string> = {
  alabama: "AL",
  alaska: "AK",
  arizona: "AZ",
  arkansas: "AR",
  california: "CA",
  colorado: "CO",
  connecticut: "CT",
  delaware: "DE",
  "district of columbia": "DC",
  florida: "FL",
  georgia: "GA",
  hawaii: "HI",
  idaho: "ID",
  illinois: "IL",
  indiana: "IN",
  iowa: "IA",
  kansas: "KS",
  kentucky: "KY",
  louisiana: "LA",
  maine: "ME",
  maryland: "MD",
  massachusetts: "MA",
  michigan: "MI",
  minnesota: "MN",
  mississippi: "MS",
  missouri: "MO",
  montana: "MT",
  nebraska: "NE",
  nevada: "NV",
  "new hampshire": "NH",
  "new jersey": "NJ",
  "new mexico": "NM",
  "new york": "NY",
  "north carolina": "NC",
  "north dakota": "ND",
  ohio: "OH",
  oklahoma: "OK",
  oregon: "OR",
  pennsylvania: "PA",
  "puerto rico": "PR",
  "rhode island": "RI",
  "south carolina": "SC",
  "south dakota": "SD",
  tennessee: "TN",
  texas: "TX",
  utah: "UT",
  vermont: "VT",
  virginia: "VA",
  washington: "WA",
  "west virginia": "WV",
  wisconsin: "WI",
  wyoming: "WY",
};
const STATE_CODES = new Set(Object.values(US_STATES));

/** A US state as its two-letter code, or null if `s` is not one. */
export function stateCode(s: string | null | undefined): string | null {
  const t = (s ?? "").trim().replace(/\.$/, "");
  if (!t) return null;
  if (STATE_CODES.has(t.toUpperCase()) && t.length === 2) return t.toUpperCase();
  return US_STATES[t.toLowerCase()] ?? null;
}

const COUNTRY = /^(usa|us|u\.s\.a?\.?|united states( of america)?)$/i;
const ZIP = /^\d{5}(?:-\d{4})?$/;
const UNIT =
  /^(?:#\s*\S+|(?:apt|apartment|unit|ste|suite|fl|floor|bldg|building|rm|room|lot|spc|space)\.?\s*#?\s*\S+)$/i;
// Street suffixes, for telling where a street line ends and a city starts
// when the two are not separated by a comma ("2000 Brush Street Detroit").
const STREET_END =
  /^(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|ct|court|pl|place|way|ter|terrace|cir|circle|pkwy|parkway|hwy|highway|trl|trail|sq|square|loop|row|run|pike|aly|alley|xing|crossing)\.?$/i;
// A post-directional ("Main St NW"). Abbreviations only: "West" after a
// street line is as likely to start "West Bloomfield" as to end the street.
const POST_DIRECTIONAL = /^(?:n|s|e|w|ne|nw|se|sw)\.?$/i;

/** Split "2000 Brush St, Detroit, MI 48226, USA" — or the suggestion-row
 *  shape "2000 Brush Street Detroit, MI, USA", or a pasted one-liner — into
 *  street / unit / city / state / ZIP. A part it cannot find is "". */
export function parseFormattedAddress(line: string | null | undefined): ParsedAddress {
  const out: ParsedAddress = { street: "", unit: "", city: "", region: "", postalCode: "" };
  let parts = (line ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length && COUNTRY.test(parts[parts.length - 1])) parts = parts.slice(0, -1);
  if (!parts.length) return out;

  // The tail: "MI 48226", "MI", "48226", "Michigan 48226".
  const tail = parts[parts.length - 1];
  const tailZip = tail.match(/(\d{5}(?:-\d{4})?)$/);
  const tailRest = (tailZip ? tail.slice(0, tailZip.index) : tail).trim();
  if (tailZip && (tailRest === "" || stateCode(tailRest))) {
    out.postalCode = tailZip[1];
    out.region = stateCode(tailRest) ?? "";
    parts = parts.slice(0, -1);
  } else if (tailZip && /^(.*\S)\s+([A-Za-z]{2})$/.test(tailRest)) {
    // "Ann Arbor MI 48104": city, state and ZIP with no comma between them.
    const m = tailRest.match(/^(.*\S)\s+([A-Za-z]{2})$/)!;
    if (stateCode(m[2])) {
      out.postalCode = tailZip[1];
      out.region = stateCode(m[2])!;
      parts[parts.length - 1] = m[1];
    }
  } else if (stateCode(tailRest) && parts.length > 1) {
    out.region = stateCode(tailRest)!;
    parts = parts.slice(0, -1);
  } else if (ZIP.test(tail)) {
    out.postalCode = tail;
    parts = parts.slice(0, -1);
  }
  // "Detroit MI 48226" with no comma before the state.
  if (!out.region && parts.length) {
    const m = parts[parts.length - 1].match(/^(.*\S)\s+([A-Za-z]{2})$/);
    if (m && stateCode(m[2]) && parts.length > 1) {
      out.region = stateCode(m[2])!;
      parts[parts.length - 1] = m[1];
    }
  }
  if (!parts.length) return out;

  if (parts.length === 1) {
    // Only a street line, or a street line with the city run onto it.
    const words = parts[0].split(/\s+/);
    if (/^\d/.test(words[0] ?? "") && (out.region || out.postalCode)) {
      const cut = lastStreetEnd(words);
      if (cut > 0 && cut < words.length) {
        out.street = words.slice(0, cut).join(" ");
        out.city = words.slice(cut).join(" ");
        return out;
      }
    }
    if (/^\d/.test(parts[0])) out.street = parts[0];
    else out.city = parts[0];
    return out;
  }

  out.city = parts[parts.length - 1];
  const rest = parts.slice(0, -1);
  out.street = rest[0];
  const unit = rest.slice(1).find((p) => UNIT.test(p));
  if (unit) out.unit = unit;
  return out;
}

function lastStreetEnd(words: string[]): number {
  let cut = -1;
  for (let i = 1; i < words.length; i++) if (STREET_END.test(words[i])) cut = i + 1;
  if (cut > 0 && cut < words.length - 1 && POST_DIRECTIONAL.test(words[cut])) cut++;
  return cut;
}

function text(c: PlaceComponent, short: boolean): string {
  const long = c.longText ?? c.long_name;
  const sh = c.shortText ?? c.short_name;
  return ((short ? (sh ?? long) : (long ?? sh)) ?? "").trim();
}

function pick(components: PlaceComponent[], types: string[], short = false): string {
  for (const type of types) {
    const c = components.find((x) => x.types?.includes(type));
    if (c) {
      const v = text(c, short);
      if (v) return v;
    }
  }
  return "";
}

/** Does `line` start with a house number? */
const HOUSE_NUMBER = /^\d+[A-Za-z]?(?:-\d+)?\s+\S/;

/** Map a Places result to the parts a form stores. Components first, then the
 *  place's formatted address, then (street line only) the picked suggestion.
 *  The result may still be incomplete; `isCompletePick` decides. */
export function addressFromPlace(place: PlaceInput): AddressDetails {
  const comps = place.addressComponents ?? [];
  const formatted = (place.formattedAddress ?? "").trim();
  const fromFormatted = parseFormattedAddress(formatted);
  const mainText = (place.suggestion?.mainText ?? "").trim();
  const secondary = (place.suggestion?.secondaryText ?? "").trim();
  const fromSuggestion = parseFormattedAddress([mainText, secondary].filter(Boolean).join(", "));

  const number = pick(comps, ["street_number"]);
  const route = pick(comps, ["route"]);
  let street = [number, route].filter(Boolean).join(" ");
  if (!HOUSE_NUMBER.test(street)) {
    // No house number in the components. Take the street line from the place's
    // own formatted address if it has one, else from the row the person picked —
    // the line they chose is the line they meant.
    if (HOUSE_NUMBER.test(fromFormatted.street)) street = fromFormatted.street;
    else if (HOUSE_NUMBER.test(fromSuggestion.street)) street = fromSuggestion.street;
    else if (HOUSE_NUMBER.test(mainText)) street = mainText;
    else street = street || pick(comps, ["premise"]) || fromFormatted.street;
  }

  const city =
    pick(comps, [
      "locality",
      "postal_town",
      "sublocality_level_1",
      "sublocality",
      "administrative_area_level_3",
      "neighborhood",
    ]) ||
    fromFormatted.city ||
    fromSuggestion.city;

  const region =
    stateCode(pick(comps, ["administrative_area_level_1"], true)) ??
    (pick(comps, ["administrative_area_level_1"], true) ||
      fromFormatted.region ||
      fromSuggestion.region);

  const postalCode = pick(comps, ["postal_code"]) || fromFormatted.postalCode;

  const unit = pick(comps, ["subpremise"]) || fromFormatted.unit;
  const lat = place.location?.latitude;
  const lng = place.location?.longitude;
  const details: AddressDetails = {
    street,
    unit: unit || null,
    city,
    region: region || null,
    postalCode,
    latitude: typeof lat === "number" ? lat : null,
    longitude: typeof lng === "number" ? lng : null,
    formatted: "",
  };
  details.formatted = formatted || formatAddressLine({ street, unit, city, region, postalCode });
  return details;
}

/** "Street, Unit, City, ST ZIP" — the one-line form of a stored address, with
 *  the state in it (#805: the saved and shown address used to read
 *  "2000 Brush St, Detroit 48201"). Empty parts drop out cleanly. */
export function formatAddressLine(a: {
  street?: string | null;
  unit?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  postal_code?: string | null;
}): string {
  const zip = (a.postalCode ?? a.postal_code ?? "").trim();
  const stateZip = [(a.region ?? "").trim(), zip].filter(Boolean).join(" ");
  return [a.street, a.unit, a.city, stateZip]
    .map((p) => (p ?? "").trim())
    .filter(Boolean)
    .join(", ");
}
