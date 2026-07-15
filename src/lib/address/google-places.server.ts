// Google Places API (New) implementation of AddressProvider.
//
// Uses the v1 REST endpoints (places:autocomplete + place details) with an
// API key read from GOOGLE_PLACES_API_KEY on the server. USA-only,
// address-first (street_address/premise/subpremise primary types), with an
// optional location bias circle around the workspace's service area.
// Google is ONLY used for address search; geocoding results feed the same
// OSM/Leaflet map stack as before.
import type {
  AddressProvider,
  AddressSuggestion,
  AddressDetails,
} from "@/lib/address/provider.server";

const AUTOCOMPLETE_URL = "https://places.googleapis.com/v1/places:autocomplete";
const DETAILS_URL = "https://places.googleapis.com/v1/places";
const BIAS_RADIUS_METERS = 50_000;

function apiKey(): string | undefined {
  return process.env.GOOGLE_PLACES_API_KEY || undefined;
}

interface GoogleComponent {
  longText?: string;
  shortText?: string;
  types?: string[];
}

function component(components: GoogleComponent[], type: string, short = false): string | null {
  const c = components.find((x) => x.types?.includes(type));
  if (!c) return null;
  return (short ? (c.shortText ?? c.longText) : (c.longText ?? c.shortText)) ?? null;
}

export const googlePlacesProvider: AddressProvider = {
  name: "google-places",

  isConfigured() {
    return !!apiKey();
  },

  async autocomplete(query, opts) {
    const key = apiKey();
    if (!key) return [];
    const body: Record<string, unknown> = {
      input: query,
      // USA only, residential addresses first: restrict to precise
      // address-level primary types so house numbers outrank businesses.
      includedRegionCodes: ["us"],
      includedPrimaryTypes: ["street_address", "premise", "subpremise"],
    };
    if (opts?.sessionToken) body.sessionToken = opts.sessionToken;
    if (opts?.bias) {
      body.locationBias = {
        circle: {
          center: { latitude: opts.bias.latitude, longitude: opts.bias.longitude },
          radius: BIAS_RADIUS_METERS,
        },
      };
    }

    const res = await fetch(AUTOCOMPLETE_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": key,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn("places autocomplete failed:", res.status, await res.text().catch(() => ""));
      return [];
    }
    const json = (await res.json()) as {
      suggestions?: Array<{
        placePrediction?: {
          placeId?: string;
          structuredFormat?: {
            mainText?: { text?: string };
            secondaryText?: { text?: string };
          };
          text?: { text?: string };
        };
      }>;
    };
    const out: AddressSuggestion[] = [];
    for (const s of json.suggestions ?? []) {
      const p = s.placePrediction;
      if (!p?.placeId) continue;
      out.push({
        id: p.placeId,
        mainText: p.structuredFormat?.mainText?.text ?? p.text?.text ?? "",
        secondaryText: p.structuredFormat?.secondaryText?.text ?? "",
      });
    }
    return out;
  },

  async details(placeId, opts) {
    const key = apiKey();
    if (!key) return null;
    // Place ids are provider-controlled; keep the path strictly one segment.
    const safeId = encodeURIComponent(placeId);
    const url = new URL(`${DETAILS_URL}/${safeId}`);
    if (opts?.sessionToken) url.searchParams.set("sessionToken", opts.sessionToken);

    const res = await fetch(url, {
      headers: {
        "X-Goog-Api-Key": key,
        "X-Goog-FieldMask": "addressComponents,location,formattedAddress",
      },
    });
    if (!res.ok) {
      console.warn("places details failed:", res.status, await res.text().catch(() => ""));
      return null;
    }
    const json = (await res.json()) as {
      addressComponents?: GoogleComponent[];
      location?: { latitude?: number; longitude?: number };
      formattedAddress?: string;
    };
    const comps = json.addressComponents ?? [];
    const streetNumber = component(comps, "street_number");
    const route = component(comps, "route");
    const street = [streetNumber, route].filter(Boolean).join(" ");
    const city =
      component(comps, "locality") ??
      component(comps, "sublocality") ??
      component(comps, "administrative_area_level_3") ??
      "";
    const details: AddressDetails = {
      street,
      unit: component(comps, "subpremise"),
      city,
      region: component(comps, "administrative_area_level_1", true),
      postalCode: component(comps, "postal_code") ?? "",
      latitude: json.location?.latitude ?? null,
      longitude: json.location?.longitude ?? null,
      formatted: json.formattedAddress ?? "",
    };
    if (!details.street || !details.postalCode) return null;
    return details;
  },
};
