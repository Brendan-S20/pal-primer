// Where a business works, for biasing address search toward it (#783).
//
// Onboarding QA typed `200 Test Ave` into a new Lansing, MI business's
// first client and was offered Richmond IN, York PA, Bellefonte PA,
// Waynesville NC and Council Bluffs IA — nothing near Lansing. The bias
// was there in principle, but it was taken only from the average of the
// org's geocoded properties, then from zone centres. A new business has
// no properties, and a setup zone may have no centre, so the one point it
// DID have — its own business address, geocoded into
// `organizations.latitude/longitude` when it is saved — was never asked.
//
// Two things now follow from knowing that point:
//
//   1. it is the first answer to "where is this business", ahead of the
//      property average and zone centres (which keep their old order);
//   2. a suggestion that comes back with its distance is RANKED by it and,
//      beyond SERVICE_RADIUS_METERS, dropped. Google's location bias is a
//      preference, not a fence: when nothing nearby matches it fills the
//      list from anywhere in the country, and a scooping business in
//      Lansing has no client in Council Bluffs. Typing by hand still works
//      for the rare one that is genuinely that far.

export interface LatLng {
  latitude: number;
  longitude: number;
}

/** 100 miles. Generous for a one-or-two-truck route; anything further from
 *  the business is far more likely to be a wrong match than a client. */
export const SERVICE_RADIUS_METERS = 160_934;

function finitePoint(lat: unknown, lng: unknown): LatLng | null {
  if (lat == null || lng == null) return null;
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
  // (0,0) is the Gulf of Guinea, and what a zeroed column looks like.
  if (latitude === 0 && longitude === 0) return null;
  return { latitude, longitude };
}

function average(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null;
  return {
    latitude: points.reduce((s, p) => s + p.latitude, 0) / points.length,
    longitude: points.reduce((s, p) => s + p.longitude, 0) / points.length,
  };
}

/** The centre to bias address search toward: the business's own location
 *  when it has one, then the average of its geocoded properties, then the
 *  average of its zone centres. Null when none of them is known. */
export function serviceAreaCenter(input: {
  business?: { latitude?: unknown; longitude?: unknown } | null;
  zones?: Array<{
    center_latitude?: unknown;
    center_longitude?: unknown;
    latitude?: unknown;
    longitude?: unknown;
  }> | null;
  properties?: Array<{ latitude?: unknown; longitude?: unknown }> | null;
}): LatLng | null {
  const business = finitePoint(input.business?.latitude, input.business?.longitude);
  if (business) return business;
  const properties = average(
    (input.properties ?? [])
      .map((p) => finitePoint(p.latitude, p.longitude))
      .filter((p): p is LatLng => p !== null),
  );
  if (properties) return properties;
  return average(
    (input.zones ?? [])
      .map((z) => finitePoint(z.center_latitude ?? z.latitude, z.center_longitude ?? z.longitude))
      .filter((p): p is LatLng => p !== null),
  );
}

/** Nearest first, and nothing beyond the service radius. A suggestion with
 *  no distance (the provider did not say) is kept, after every one that did:
 *  it cannot be shown to be far, and dropping it could empty a good list.
 *  With no centre known the provider's own order stands. */
export function nearBusinessFirst<T extends { distanceMeters?: number | null }>(
  suggestions: T[],
  opts: { centerKnown: boolean; radiusMeters?: number },
): T[] {
  if (!opts.centerKnown) return suggestions;
  const radius = opts.radiusMeters ?? SERVICE_RADIUS_METERS;
  const measured = suggestions
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => typeof s.distanceMeters === "number" && Number.isFinite(s.distanceMeters));
  const unmeasured = suggestions.filter(
    (s) => !(typeof s.distanceMeters === "number" && Number.isFinite(s.distanceMeters)),
  );
  const near = measured
    .filter(({ s }) => (s.distanceMeters as number) <= radius)
    .sort((a, b) => (a.s.distanceMeters as number) - (b.s.distanceMeters as number) || a.i - b.i)
    .map(({ s }) => s);
  return [...near, ...unmeasured];
}
