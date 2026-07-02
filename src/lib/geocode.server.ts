// Server-only Google Maps geocoding via the connector gateway.

const GATEWAY_URL = "https://connector-gateway.lovable.dev/google_maps";

export type GeocodeResult = { latitude: number; longitude: number } | null;

export async function geocodeAddress(parts: {
  street?: string | null;
  city?: string | null;
  region?: string | null;
  postal_code?: string | null;
  country?: string | null;
}): Promise<GeocodeResult> {
  const lovableKey = process.env.LOVABLE_API_KEY;
  const mapsKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!lovableKey || !mapsKey) return null;

  const address = [parts.street, parts.city, parts.region, parts.postal_code, parts.country]
    .filter(Boolean)
    .join(", ")
    .trim();
  if (!address) return null;

  try {
    const res = await fetch(
      `${GATEWAY_URL}/maps/api/geocode/json?address=${encodeURIComponent(address)}`,
      {
        headers: {
          Authorization: `Bearer ${lovableKey}`,
          "X-Connection-Api-Key": mapsKey,
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const loc = data?.results?.[0]?.geometry?.location;
    if (typeof loc?.lat === "number" && typeof loc?.lng === "number") {
      return { latitude: loc.lat, longitude: loc.lng };
    }
    return null;
  } catch {
    return null;
  }
}
