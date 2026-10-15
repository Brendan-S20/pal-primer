/**
 * Which zone a visit is counted under on /reports (#437, QA row 31).
 *
 * Reports grouped visits by `visits.zone_id` alone, and that column is copied
 * from the service when the visit is generated. A service set up before its
 * yard had a zone, or one whose zone was only ever worked out by address,
 * passes on a null, so on the demo org every visit sat under "No zone" while
 * every property had one.
 *
 * The property is where a zone is kept current (`redetectZonesForOrg`, and
 * the note at the top of lib/pricing-drift.ts), so it is the fallback: the
 * visit's own zone when it has one, then the property's chosen zone, then the
 * one detected from its address. The same order one-off-visit.server.ts uses
 * when it creates a visit. "no_zone" only when none of the three exists.
 */
export const NO_ZONE = "no_zone";

type PropertyZones = { zone_id?: string | null; auto_zone_id?: string | null } | null;

export type VisitZoneSource = {
  zone_id: string | null;
  /** The embedded property. PostgREST returns a to-one embed as an object;
   *  an array is accepted too, so a change in how it is typed cannot turn
   *  every visit back into "No zone". */
  properties?: PropertyZones | PropertyZones[];
};

export function reportZoneId(v: VisitZoneSource): string {
  const prop = Array.isArray(v.properties) ? (v.properties[0] ?? null) : (v.properties ?? null);
  return v.zone_id ?? prop?.zone_id ?? prop?.auto_zone_id ?? NO_ZONE;
}
