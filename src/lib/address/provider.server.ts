// AddressProvider interface (client detail refactor, Stage 4).
//
// Address SEARCH is pluggable: Google Places Autocomplete (New) today,
// Pelias later, without UI changes. The provider runs strictly server-side
// (the API key never reaches the browser); the client talks to our server
// functions in address.functions.ts, which proxy to whichever provider is
// configured. Maps stay OSM/Leaflet; this is search only.

export interface AddressSuggestion {
  /** Provider-specific place id, passed back to details(). */
  id: string;
  /** Primary line, e.g. "1600 Pennsylvania Ave NW". */
  mainText: string;
  /** Secondary line, e.g. "Washington, DC, USA". */
  secondaryText: string;
}

export interface AddressDetails {
  street: string;
  /** Apartment / suite / unit, stored separately from the street line. */
  unit: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  latitude: number | null;
  longitude: number | null;
  formatted: string;
}

export interface AddressProvider {
  readonly name: string;
  /** False when the provider's credentials are missing; the UI then falls
   * back to plain manual entry. */
  isConfigured(): boolean;
  autocomplete(
    query: string,
    opts?: {
      /** Bias results toward the workspace's service area. */
      bias?: { latitude: number; longitude: number } | null;
      /** Groups keystrokes + the final details call for billing. */
      sessionToken?: string;
    },
  ): Promise<AddressSuggestion[]>;
  details(placeId: string, opts?: { sessionToken?: string }): Promise<AddressDetails | null>;
}
