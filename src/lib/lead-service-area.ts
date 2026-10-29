// Is a lead's ZIP somewhere this business works? (#439)
//
// The audit found leads on /leads with New York ZIPs (10001, 10003, 10024)
// for a business whose zones are elsewhere, and nothing on the row said so.
// The office would call, quote and maybe convert a lead it cannot serve.
//
// A lead has no coordinates, only the text the form saved in `location`
// (street, city, "ST 12345", or a bare ZIP). So this can only answer with
// the ZIP levels of the matcher: an exact listed ZIP or a postal prefix,
// the same two levels the public_quote RPC uses for a signup.
//
// It answers "unknown" rather than "outside" whenever the ZIP cannot settle
// it: no ZIP in the text, no zone at all, or any zone that is drawn on a map
// (radius, drive time, polygon) with no ZIPs listed, since that zone may
// well cover the ZIP and only its geometry knows. A false "outside" on a
// lead the business can serve costs more than a missing one.

import { matchZone, type ZoneMatchFields } from "@/lib/zone-match";

export type LeadAreaVerdict = "inside" | "outside" | "unknown";

/** The last five-digit run in the text, with or without a +4. A US street
 *  number comes before the ZIP, so the last run is the ZIP. */
export function zipFromLocation(location: string | null | undefined): string | null {
  const runs = (location ?? "").match(/\b\d{5}(?:-\d{4})?\b/g);
  if (!runs?.length) return null;
  return runs[runs.length - 1].slice(0, 5);
}

function listsAnArea(z: ZoneMatchFields): boolean {
  return (z.zip_codes?.length ?? 0) > 0 || !!z.postal_prefix?.trim();
}

export function leadServiceArea(
  location: string | null | undefined,
  zones: readonly ZoneMatchFields[],
): LeadAreaVerdict {
  const zip = zipFromLocation(location);
  if (!zip || zones.length === 0) return "unknown";
  if (!zones.every(listsAnArea)) return "unknown";
  return matchZone([...zones], { postalCode: zip }) ? "inside" : "outside";
}
