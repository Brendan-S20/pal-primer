// Which outside service draws the map, measures the roads, finds an address
// and forecasts the weather -- chosen by configuration, not by code.
//
// ── WHY ──────────────────────────────────────────────────────────────────
//
// All four run today on free public services: OpenStreetMap tiles (the
// fallback basemap), the OSRM demo router, Nominatim (behind Geocodio when a
// key is set) and Open-Meteo's free tier. Each of them has a usage policy
// that a commercial app can outgrow (issue #529), and moving off one should
// be a variable and a key in the hosting secrets, not an edit to four files.
//
// So each service has a small ADAPTER type, a registry of adapters keyed by
// id, and one environment variable that picks one. Unset, every service picks
// exactly what it used before this file existed: behaviour is unchanged until
// somebody sets a variable.
//
// ── THE VARIABLES ────────────────────────────────────────────────────────
//
//   service     picks the adapter            key                 base URL
//   ---------   ---------------------------  ------------------  -----------------
//   routing     ROUTING_PROVIDER   (osrm)    ROUTING_API_KEY     ROUTING_URL
//   geocoding   GEOCODING_PROVIDER (*)       GEOCODING_API_KEY   GEOCODING_URL
//               GEOCODING_FALLBACK (nominatim, or "none")
//   weather     WEATHER_PROVIDER   (open-meteo) WEATHER_API_KEY   WEATHER_URL
//   map tiles   VITE_MAP_TILES_PROVIDER (osm) VITE_MAP_TILES_KEY VITE_MAP_TILES_URL
//
//   (*) unset: "geocodio" when GEOCODIO_API_KEY is set, else "nominatim" --
//       the rule geocode.server.ts has always followed.
//
// The existing service-specific names keep working and keep their meaning:
// OSRM_URL / OSRM_ENDPOINTS / OSRM_MAX_TABLE for the osrm adapter,
// GEOCODIO_API_KEY for the geocodio adapter.
//
// Tiles are VITE_-prefixed because the fallback basemap is drawn in the
// browser and only VITE_ names are inlined into the bundle. A tile key is a
// browser key, public by nature, exactly like the Google Maps browser key.
//
// ── A NAME NOBODY REGISTERED IS AN ERROR, NOT A DEFAULT ──────────────────
//
// `WEATHER_PROVIDER=open-meteo-comercial` (sic) must not quietly fall back to
// the free public service: that is the very request a paid provider was set
// up to stop. pickProvider throws ProviderConfigError, naming the variable
// and the ids it would have accepted. Each caller decides what that costs:
// routing and weather report a failure (and the planner / the forecast cache
// already degrade around one); geocoding logs it and returns no point, which
// is the same answer as an address that did not match.
//
// This file names no host and holds no key. It is imported by browser and
// server code alike.

export type ProviderEnv = Readonly<Record<string, string | undefined>>;

export type ProviderService = "routing" | "geocoding" | "weather" | "map-tiles";

export class ProviderConfigError extends Error {
  readonly service: ProviderService;
  constructor(service: ProviderService, message: string) {
    super(message);
    this.name = "ProviderConfigError";
    this.service = service;
  }
}

/** The variable that picks each service's adapter. */
export const PROVIDER_VARIABLE: Record<ProviderService, string> = {
  routing: "ROUTING_PROVIDER",
  geocoding: "GEOCODING_PROVIDER",
  weather: "WEATHER_PROVIDER",
  "map-tiles": "VITE_MAP_TILES_PROVIDER",
};

const PREFIX: Record<ProviderService, string> = {
  routing: "ROUTING",
  geocoding: "GEOCODING",
  weather: "WEATHER",
  "map-tiles": "VITE_MAP_TILES",
};

/** A trimmed, non-empty value, or null. "" in a hosting dashboard means unset. */
export function envValue(env: ProviderEnv, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

/** What every adapter is handed besides its own inputs: the generic key and
 *  base URL for its service, and the whole env for anything adapter-specific
 *  (OSRM_ENDPOINTS, GEOCODIO_API_KEY, ...). */
export type ProviderContext = {
  key: string | null;
  url: string | null;
  env: ProviderEnv;
};

export function providerContext(service: ProviderService, env: ProviderEnv): ProviderContext {
  return {
    key: envValue(env, `${PREFIX[service]}_API_KEY`) ?? envValue(env, `${PREFIX[service]}_KEY`),
    url: envValue(env, `${PREFIX[service]}_URL`),
    env,
  };
}

/** The id the env asks for, lower-cased, or `fallbackId` when it asks for
 *  nothing. Does not check that anything is registered under it. */
export function requestedProvider(
  service: ProviderService,
  env: ProviderEnv,
  fallbackId: string,
): string {
  return (envValue(env, PROVIDER_VARIABLE[service]) ?? fallbackId).toLowerCase();
}

/** The registered adapter for `id`, or a ProviderConfigError that says which
 *  variable to fix and what it may be set to. */
export function adapterFor<A extends { id: string }>(
  service: ProviderService,
  registry: ReadonlyMap<string, A>,
  id: string,
  variable: string = PROVIDER_VARIABLE[service],
): A {
  const adapter = registry.get(id);
  if (adapter) return adapter;
  throw new ProviderConfigError(
    service,
    `${variable}="${id}" is not a ${service} provider this build knows. ` +
      `Known: ${[...registry.keys()].join(", ") || "(none)"}.`,
  );
}

/** requestedProvider + adapterFor: the adapter the environment selects. */
export function pickProvider<A extends { id: string }>(
  service: ProviderService,
  env: ProviderEnv,
  registry: ReadonlyMap<string, A>,
  defaultId: string,
): A {
  return adapterFor(service, registry, requestedProvider(service, env, defaultId));
}

/** process.env where there is one (the server), {} where there is not. */
export function serverEnv(): ProviderEnv {
  return typeof process !== "undefined" && process.env ? process.env : {};
}
