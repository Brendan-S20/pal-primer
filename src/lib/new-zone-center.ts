import type { LatLng } from "@/lib/maps/types";

type Point = { latitude: number | null; longitude: number | null };
function point(value: Point | null | undefined): LatLng | null {
  const lat = value?.latitude;
  const lng = value?.longitude;
  return typeof lat === "number" &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    typeof lng === "number" &&
    Number.isFinite(lng) &&
    Math.abs(lng) <= 180
    ? { lat, lng }
    : null;
}

/** Business address first; stored org start point if the lookup is unavailable. */
export async function newZoneCenter(
  org: Point & { contact_address: string | null },
  geocode: (address: string) => Promise<Point | null>,
): Promise<LatLng | null> {
  if (org.contact_address?.trim()) {
    try {
      const business = point(await geocode(org.contact_address));
      if (business) return business;
    } catch {
      // A geocoder outage must not prevent creating a zone.
    }
  }
  return point(org);
}
