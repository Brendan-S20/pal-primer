/**
 * The businesses the routing trials plan a day for.
 *
 * Every coordinate here is a PUBLIC place -- a park, a school, a city hall, a
 * stadium -- typed in by hand, so nothing is geocoded at run time and no
 * customer's address is anywhere in this file. The one generated set (the
 * large Phoenix day) is uniform random points inside a box of desert suburbs,
 * seeded, so it is the same 200 points on every run.
 *
 * Each scenario is a shape a real tenant will have, chosen because it breaks
 * a different assumption: a one-way grid, sprawl, 30-mile gaps, a bay that is
 * close as the crow flies and far by road, a metro across a state line, a
 * time zone that is not Central, a day too big for the router, a day too big
 * for the hours, and every kind of bad row a real import produces.
 */

export type LatLon = [number, number];

export type Window = { earliest?: string; latest?: string; on: "subscription" | "property" };

export type StopSpec = {
  key: string;
  name: string;
  lat: number | null;
  lon: number | null;
  serviceMin?: number;
  window?: Window;
  pref?: "morning" | "afternoon";
  /** Assigned before routing (e.g. by the nightly generator). */
  preassign?: string;
  /** Which shore of a water barrier this stop is on, for the crossing count. */
  side?: string;
};

export type TechSpec = {
  key: string;
  name: string;
  start: LatLon | null;
  end?: LatLon | null;
  capacityMin?: number | null;
  offToday?: boolean;
  isFieldTech?: boolean;
  /** Selected in the panel. Default true. */
  selected?: boolean;
};

export type OsrmMode =
  /** Replay the recorded public-OSRM answer for exactly this request. */
  | "fixture"
  /** The router cannot be reached at all (DNS, timeout, outage). */
  | "down"
  /** The router answers 429, which is what the public demo does under load. */
  | "rate_limited";

export type Scenario = {
  id: string;
  title: string;
  /** The question this scenario exists to ask. */
  question: string;
  org: {
    tz: string;
    areaType: "dense_urban" | "urban" | "suburban" | "rural";
    workdayStart?: string;
    workdayEnd?: string;
    business?: LatLon | null;
  };
  day: string;
  techs: TechSpec[];
  stops: StopSpec[];
  dumps?: Array<{ name: string; at: LatLon }>;
  osrm: OsrmMode;
  /** Name of the fixture file in fixtures/osrm/, shared by variants of one geography. */
  fixture?: string;
};

// ── Small helpers ───────────────────────────────────────────────────────────

const s = (
  key: string,
  name: string,
  lat: number | null,
  lon: number | null,
  extra: Partial<StopSpec> = {},
): StopSpec => ({
  key,
  name,
  lat,
  lon,
  ...extra,
});

/** mulberry32: a 32-bit seeded PRNG, so the generated day is identical on every run. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── 1. Dense urban: Manhattan ───────────────────────────────────────────────

const manhattanStops: StopSpec[] = [
  s("bryant", "Bryant Park", 40.7536, -73.9832),
  s("madsq", "Madison Square Park", 40.742, -73.9876),
  s("washsq", "Washington Square Park", 40.7308, -73.9973),
  s("tompkins", "Tompkins Square Park", 40.7265, -73.9815),
  s("stuyhs", "Stuyvesant High School", 40.7178, -74.0137),
  s("gct", "Grand Central Terminal", 40.7527, -73.9772),
  s("chelsea", "Chelsea Market", 40.7424, -74.006),
  s("colcircle", "Columbus Circle", 40.7681, -73.9819),
  s("lincoln", "Lincoln Center", 40.7725, -73.9835),
  s("amnh", "Museum of Natural History", 40.7813, -73.974),
  s("met", "Metropolitan Museum", 40.7794, -73.9632),
  s("schurz", "Carl Schurz Park", 40.7754, -73.9434),
  s("hunter", "Hunter College", 40.7685, -73.9646),
  s("sdr", "Sara D. Roosevelt Park", 40.7202, -73.9925),
  s("battery", "Battery Park", 40.7033, -74.017),
  s("cityhall", "City Hall Park", 40.7128, -74.006),
  s("stuysq", "Stuyvesant Square", 40.7338, -73.9839),
  s("pier40", "Hudson River Park Pier 40", 40.729, -74.0115),
  s("gramercy", "Gramercy Park", 40.738, -73.9862),
  s("morningside", "Morningside Park", 40.8058, -73.959),
  s("garvey", "Marcus Garvey Park", 40.8045, -73.9445),
  s("stnick", "St. Nicholas Park", 40.817, -73.948),
];

// ── 2. Suburban sprawl: Plano / Collin County ───────────────────────────────

const PLANO_CITY_HALL: LatLon = [33.0198, -96.6989];

const planoStops: StopSpec[] = [
  s("arbor", "Arbor Hills Nature Preserve", 33.0496, -96.8468),
  s("oakpoint", "Oak Point Park", 33.0532, -96.6789),
  s("legacy", "Legacy West", 33.0773, -96.825),
  s("willow", "Shops at Willow Bend", 33.03, -96.7686),
  s("outlets", "Allen Premium Outlets", 33.127, -96.688),
  s("toyota", "Toyota Stadium, Frisco", 33.1545, -96.8353),
  s("mckinney", "McKinney Historic Square", 33.1976, -96.6153),
  s("breck", "Breckinridge Park, Richardson", 32.995, -96.661),
  s("murphy", "Murphy Central Park", 33.0144, -96.617),
  s("wylie", "Downtown Wylie", 33.0151, -96.5389),
  s("parker", "Parker City Hall", 33.057, -96.6206),
  s("lucas", "Lucas Community Park", 33.0843, -96.5766),
  s("friscolib", "Frisco Public Library", 33.153, -96.8216),
  s("prosper", "Prosper Town Hall", 33.2362, -96.8011),
  s("littleelm", "Little Elm Park", 33.162, -96.933),
  s("josey", "Josey Ranch Lake, Carrollton", 32.993, -96.887),
  s("garland", "Downtown Garland", 32.9126, -96.6389),
  s("sachse", "Sachse City Hall", 32.9765, -96.5953),
  s("collin", "Collin College Spring Creek", 33.0368, -96.6996),
  s("utd", "UT Dallas", 32.9858, -96.7501),
  s("planohs", "Plano Senior High", 33.0437, -96.751),
  s("haggard", "Haggard Park, Plano", 33.0193, -96.7013),
  s("celebration", "Celebration Park, Allen", 33.0893, -96.701),
  s("fairview", "Village at Fairview", 33.128, -96.617),
];

// ── 3. Rural: Gallatin Valley, Montana ──────────────────────────────────────

const BOZEMAN: LatLon = [45.6795, -111.0386];

const gallatinStops: StopSpec[] = [
  s("belgrade", "Belgrade", 45.776, -111.177),
  s("manhattanmt", "Manhattan, MT", 45.8566, -111.3322),
  s("threeforks", "Three Forks", 45.8927, -111.5522),
  s("livingston", "Livingston", 45.662, -110.561),
  s("bigsky", "Big Sky Meadow Village", 45.268, -111.307),
  s("gateway", "Gallatin Gateway", 45.596, -111.196),
  s("fourcorners", "Four Corners", 45.629, -111.186),
  s("willowcreek", "Willow Creek", 45.825, -111.644),
  s("clydepark", "Clyde Park", 45.887, -110.605),
];

// ── 4. Water barrier: Tampa Bay ─────────────────────────────────────────────

const TAMPA_CITY_HALL: LatLon = [27.9478, -82.4584];
const TROPICANA: LatLon = [27.7682, -82.6534];

const tampaStops: StopSpec[] = [
  s("hydepark", "Hyde Park Village", 27.938, -82.472, { side: "tampa" }),
  s("usf", "USF Tampa", 28.0587, -82.4139, { side: "tampa" }),
  s("busch", "Busch Gardens", 28.0372, -82.4194, { side: "tampa" }),
  s("rjs", "Raymond James Stadium", 27.9759, -82.5033, { side: "tampa" }),
  s("westshore", "Westshore Plaza", 27.945, -82.526, { side: "tampa" }),
  s("ballast", "Ballast Point Park", 27.889, -82.481, { side: "tampa" }),
  s("brandon", "Westfield Brandon", 27.9294, -82.3241, { side: "tampa" }),
  s("zoo", "ZooTampa at Lowry Park", 28.013, -82.469, { side: "tampa" }),
  s("picnic", "Picnic Island Park", 27.853, -82.548, { side: "tampa" }),
  s("apollo", "Apollo Beach", 27.772, -82.42, { side: "tampa" }),
  s("pier", "St. Pete Pier", 27.773, -82.625, { side: "pinellas" }),
  s("gulfport", "Gulfport Casino", 27.736, -82.706, { side: "pinellas" }),
  s("clearwater", "Clearwater City Hall", 27.9659, -82.8001, { side: "pinellas" }),
  s("largo", "Largo Central Park", 27.9171, -82.7826, { side: "pinellas" }),
  s("pinpark", "Pinellas Park City Hall", 27.8428, -82.6995, { side: "pinellas" }),
  s("safety", "Safety Harbor", 27.9906, -82.6926, { side: "pinellas" }),
  s("oldsmar", "Oldsmar", 28.0342, -82.6651, { side: "pinellas" }),
  s("seminole", "Seminole City Center", 27.8398, -82.7912, { side: "pinellas" }),
  s("feather", "Feather Sound", 27.9, -82.665, { side: "pinellas" }),
  s("weedon", "Weedon Island Preserve", 27.846, -82.605, { side: "pinellas" }),
];

// ── 5. A metro across a state line: Kansas City MO / KS ────────────────────

const KCMO_CITY_HALL: LatLon = [39.1001, -94.5781];

const kcStops: StopSpec[] = [
  s("kck", "Kansas City, KS City Hall", 39.1141, -94.6275),
  s("olathe", "Olathe", 38.8814, -94.8191),
  s("lenexa", "Lenexa City Center", 38.96, -94.77),
  s("shawnee", "Shawnee", 39.0228, -94.7152),
  s("lees", "Lee's Summit", 38.9108, -94.3822),
  s("liberty", "Liberty Square", 39.2461, -94.4191),
  s("gladstone", "Gladstone", 39.2039, -94.5547),
  s("plaza", "Country Club Plaza", 39.0425, -94.5932),
  s("leawood", "Leawood", 38.9667, -94.6169),
  s("prairie", "Prairie Village", 38.9917, -94.6336),
  s("raytown", "Raytown", 39.0086, -94.4636),
  s("grandview", "Grandview", 38.8858, -94.533),
  s("parkville", "Parkville", 39.1911, -94.683),
  s("merriam", "Merriam", 39.0236, -94.6936),
  s("swope", "Swope Park", 39.005, -94.518),
  s("speedway", "Kansas Speedway", 39.115, -94.831),
];

// ── Time zones: a tiny day in every US zone that is not Central ─────────────

type TinyCity = { tz: string; start: LatLon; stops: StopSpec[] };

const TINY: Record<string, TinyCity> = {
  la: {
    tz: "America/Los_Angeles",
    start: [34.0537, -118.2428],
    stops: [
      s("griffith", "Griffith Observatory", 34.1184, -118.3004),
      s("echo", "Echo Park Lake", 34.0729, -118.2606),
      s("macarthur", "MacArthur Park", 34.059, -118.278),
      s("expo", "Exposition Park", 34.0169, -118.287),
      s("elysian", "Elysian Park", 34.0805, -118.239),
      s("union", "Union Station", 34.056, -118.2365),
    ],
  },
  phoenix: {
    tz: "America/Phoenix",
    start: [33.449, -112.077],
    stops: [
      s("encanto", "Encanto Park", 33.475, -112.09),
      s("papago", "Papago Park", 33.456, -111.947),
      s("phxzoo", "Phoenix Zoo", 33.45, -111.948),
      s("steele", "Steele Indian School Park", 33.498, -112.07),
      s("capitol", "Arizona State Capitol", 33.448, -112.097),
      s("southmtn", "South Mountain Park", 33.348, -112.083),
    ],
  },
  honolulu: {
    tz: "Pacific/Honolulu",
    start: [21.3069, -157.8583],
    stops: [
      s("kapiolani", "Kapiolani Park", 21.27, -157.82),
      s("alamoana", "Ala Moana Beach Park", 21.29, -157.85),
      s("manoa", "Manoa Valley District Park", 21.315, -157.81),
      s("bishop", "Bishop Museum", 21.333, -157.871),
      s("kaimuki", "Kaimuki High School", 21.285, -157.803),
      s("aloha", "Aloha Stadium", 21.373, -157.93),
    ],
  },
  anchorage: {
    tz: "America/Anchorage",
    start: [61.2181, -149.9003],
    stops: [
      s("townsq", "Town Square Park", 61.217, -149.888),
      s("kincaid", "Kincaid Park", 61.153, -150.054),
      s("westchester", "Westchester Lagoon", 61.205, -149.922),
      s("uaa", "University of Alaska Anchorage", 61.19, -149.827),
      s("russianjack", "Russian Jack Springs Park", 61.21, -149.79),
      s("dimond", "Dimond Center", 61.142, -149.864),
    ],
  },
  // A metro straddling the Eastern/Central line: Columbus GA is Eastern,
  // Phenix City AL is officially Central and keeps Eastern by custom. The
  // business is in Columbus; one customer across the river asked for 9-10.
  columbus: {
    tz: "America/New_York",
    start: [32.4664, -84.9872],
    stops: [
      s("phenix", "Phenix City Hall, AL", 32.471, -85.0008, {
        window: { earliest: "09:00", latest: "10:00", on: "subscription" },
      }),
      s("smiths", "Smiths Station, AL", 32.54, -85.098),
      s("riverwalk", "Columbus Riverwalk, GA", 32.459, -84.995),
      s("parkcross", "Columbus Park Crossing, GA", 32.549, -84.933),
      s("ladonia", "Ladonia, AL", 32.468, -85.08),
      s("lakebottom", "Lakebottom Park, GA", 32.4862, -84.9605),
    ],
  },
};

function tinyDay(
  city: string,
  day: string,
  id: string,
  title: string,
  workdayStart = "08:00",
): Scenario {
  const c = TINY[city];
  return {
    id,
    title,
    question:
      "Is the first arrival at the business's own workday start, on the business's own clock, on this date?",
    org: { tz: c.tz, areaType: "urban", workdayStart, business: c.start },
    day,
    techs: [{ key: "solo", name: "Solo Tech", start: c.start }],
    stops: c.stops,
    osrm: "down",
  };
}

// ── 6. Large day: Phoenix metro, 6 techs, 200 stops ─────────────────────────

function phoenixLarge(): StopSpec[] {
  const r = prng(20261014);
  const out: StopSpec[] = [];
  // Glendale to Mesa, Deer Valley to Tempe: suburbs and desert, no water,
  // and wide enough (about 60 x 40 km) that six trucks are a real split.
  for (let i = 0; i < 200; i++) {
    const lat = 33.35 + r() * 0.33;
    const lon = -112.3 + r() * 0.6;
    out.push(
      s(`p${i}`, `Phoenix stop ${i + 1}`, Number(lat.toFixed(5)), Number(lon.toFixed(5)), {
        serviceMin: 10,
      }),
    );
  }
  return out;
}

// ── 7. Edge cases ───────────────────────────────────────────────────────────

const edgeStops: StopSpec[] = [
  ...planoStops.slice(0, 12),
  // Never geocoded: an import row whose address Nominatim could not find.
  s("nullcoord", "Address that never geocoded", null, null),
  // Exactly where the first technician starts the day.
  s("atdepot", "Customer at the depot", PLANO_CITY_HALL[0], PLANO_CITY_HALL[1]),
  // Two customers at the same address (a duplex), and the same customer twice.
  s("dup1", "Duplex, unit A", 33.0705, -96.7005),
  s("dup2", "Duplex, unit B", 33.0705, -96.7005),
  // Pre-assigned to somebody who then booked the day off.
  s("offtech1", "Pre-assigned to Max (off today)", 33.0, -96.72, { preassign: "max" }),
  s("offtech2", "Also Max's", 33.005, -96.73, { preassign: "max" }),
];

// A geocode that landed on the wrong continent, and a 0,0 written instead of
// NULL. Kept apart from the edge cases above because of what they do.
const badCoordStops: StopSpec[] = [
  ...planoStops.slice(0, 8),
  s("zerocoord", "Null Island (0,0)", 0, 0),
  s("wrongcontinent", "'Paris' resolved to Paris, France", 48.8566, 2.3522),
];

// ── 7b. Time windows, set where the app actually sets them ──────────────────

const windowStops: StopSpec[] = [
  ...planoStops.slice(0, 10),
  // The app writes windows on the SUBSCRIPTION (ServicesTab, since
  // 20260716150000). These four are the realistic case.
  s("w_sub_early", "Window 08:00-09:00 (on the service)", 33.2362, -96.8011, {
    window: { earliest: "08:00", latest: "09:00", on: "subscription" },
  }),
  s("w_sub_late", "Window 15:00-16:00 (on the service)", 32.9126, -96.6389, {
    window: { earliest: "15:00", latest: "16:00", on: "subscription" },
  }),
  s("w_sub_mid", "Window 10:00-10:30 (on the service)", 33.1976, -96.6153, {
    window: { earliest: "10:00", latest: "10:30", on: "subscription" },
  }),
  s("w_sub_tight", "Window 08:00-08:20 (on the service), far away", 32.993, -96.887, {
    window: { earliest: "08:00", latest: "08:20", on: "subscription" },
  }),
  // The legacy place a window can live, which only old rows use.
  s("w_prop", "Window 09:00-09:30 (legacy, on the property)", 33.162, -96.933, {
    window: { earliest: "09:00", latest: "09:30", on: "property" },
  }),
  s("am", "Prefers mornings", 33.0843, -96.5766, { pref: "morning" }),
];

// ── The list ────────────────────────────────────────────────────────────────

const DAY = "2026-10-14"; // a Wednesday

const MANHATTAN: Scenario = {
  id: "manhattan",
  title: "Dense urban: Manhattan, 2 techs, 22 stops",
  question:
    "One-way grids and short hops: does the order hold up, and do two techs split the island sensibly?",
  org: { tz: "America/New_York", areaType: "dense_urban", business: [40.757, -73.9903] },
  day: DAY,
  techs: [
    { key: "ana", name: "Ana", start: [40.757, -73.9903] },
    { key: "ben", name: "Ben", start: [40.7359, -73.9906] },
  ],
  stops: manhattanStops,
  osrm: "fixture",
  fixture: "manhattan",
};

const PLANO: Scenario = {
  id: "plano",
  title: "Suburban sprawl: Plano TX, 3 techs, 24 stops",
  question: "Long arterials, three trucks, one tech with no start address.",
  org: { tz: "America/Chicago", areaType: "suburban", business: PLANO_CITY_HALL },
  day: DAY,
  techs: [
    { key: "cara", name: "Cara", start: [33.1507, -96.8236] },
    { key: "dev", name: "Dev", start: [32.9483, -96.7299] },
    { key: "eli", name: "Eli (no start address)", start: null },
  ],
  stops: planoStops,
  osrm: "fixture",
  fixture: "plano",
};

const TAMPA: Scenario = {
  id: "tampa",
  title: "Water barrier: Tampa Bay, 2 techs, 20 stops",
  question: "Straight-line close, road far: does a truck cross the bay more than it must?",
  org: { tz: "America/New_York", areaType: "suburban", business: TAMPA_CITY_HALL },
  day: DAY,
  techs: [
    { key: "fay", name: "Fay (Tampa)", start: TAMPA_CITY_HALL },
    { key: "gus", name: "Gus (St. Pete)", start: TROPICANA },
  ],
  stops: tampaStops,
  osrm: "fixture",
  fixture: "tampa",
};

const routerDown = (b: Scenario): Scenario => ({
  ...b,
  id: `${b.id}-router-down`,
  title: `${b.title}, router DOWN`,
  question:
    "The routing service is unreachable. Is the plan still sane, and does the result say so?",
  osrm: "down",
});

export const SCENARIOS: Scenario[] = [
  MANHATTAN,
  PLANO,
  {
    id: "gallatin",
    title: "Rural: Gallatin Valley MT, 1 tech, 9 stops",
    question: "20-40 mile gaps on a Mountain-time clock: is the day honest about how long it is?",
    org: { tz: "America/Denver", areaType: "rural", business: BOZEMAN },
    day: DAY,
    techs: [{ key: "solo", name: "Solo Tech", start: BOZEMAN }],
    stops: gallatinStops,
    osrm: "fixture",
    fixture: "gallatin",
  },
  TAMPA,
  {
    id: "kc",
    title: "State line: Kansas City MO/KS, 2 techs, 16 stops",
    question: "Does a metro split by a state line and a river route as one metro?",
    org: { tz: "America/Chicago", areaType: "urban", business: KCMO_CITY_HALL },
    day: DAY,
    techs: [
      { key: "hal", name: "Hal (Overland Park KS)", start: [38.9822, -94.6708] },
      { key: "ivy", name: "Ivy (Independence MO)", start: [39.0911, -94.4155] },
    ],
    stops: kcStops,
    osrm: "fixture",
    fixture: "kc",
  },

  // The same geographies with the router unavailable, to see the fallback.
  {
    ...PLANO,
    id: "plano-all-on-one",
    title: "Suburban sprawl: Plano TX, every stop already on Cara",
    question:
      "The nightly generator handed the whole day to one tech. Does routing three re-split it evenly?",
    stops: planoStops.map((st) => ({ ...st, preassign: "cara" })),
    osrm: "fixture",
    fixture: "plano",
  },

  routerDown(MANHATTAN),
  routerDown(PLANO),
  routerDown(TAMPA),
  {
    ...PLANO,
    id: "plano-rate-limited",
    title: "Suburban sprawl: Plano TX, router answers 429",
    question: "The public demo router rate-limits us. Is that reported as such?",
    osrm: "rate_limited",
  },

  tinyDay("la", DAY, "tz-pacific", "Pacific: Los Angeles, 1 tech, 6 stops"),
  tinyDay(
    "la",
    "2026-11-01",
    "tz-pacific-fall-back",
    "Pacific on the fall-back Sunday (25-hour day)",
  ),
  tinyDay(
    "la",
    "2026-03-08",
    "tz-pacific-spring-forward",
    "Pacific on the spring-forward Sunday (23-hour day), 07:30 start",
    "07:30",
  ),
  tinyDay("phoenix", "2026-07-15", "tz-arizona", "Arizona (no DST) in July, 1 tech, 6 stops"),
  tinyDay("honolulu", DAY, "tz-hawaii", "Hawaii: Honolulu, 1 tech, 6 stops"),
  tinyDay(
    "anchorage",
    DAY,
    "tz-alaska",
    "Alaska: Anchorage, 1 tech, 6 stops, 09:00 start",
    "09:00",
  ),
  tinyDay("columbus", DAY, "tz-straddle", "Eastern/Central line: Columbus GA + Phenix City AL"),

  {
    id: "large-phoenix",
    title: "Large day: Phoenix metro, 6 techs, 200 stops",
    question:
      "Does a 200-stop day finish inside the API's 8-second limit, assign everything, and split it evenly?",
    org: { tz: "America/Phoenix", areaType: "suburban", business: [33.449, -112.077] },
    day: DAY,
    techs: [
      { key: "t1", name: "Tech 1", start: [33.6, -112.2] },
      { key: "t2", name: "Tech 2", start: [33.6, -111.9] },
      { key: "t3", name: "Tech 3", start: [33.45, -112.25] },
      { key: "t4", name: "Tech 4", start: [33.45, -111.75] },
      { key: "t5", name: "Tech 5", start: [33.38, -112.05] },
      { key: "t6", name: "Tech 6", start: [33.5, -112.05] },
    ],
    stops: phoenixLarge(),
    osrm: "fixture",
    fixture: "large-phoenix",
  },
  {
    id: "tiny",
    title: "Tiny day: 1 tech, 6 stops (Plano)",
    question: "The smallest real business: does it just work?",
    org: { tz: "America/Chicago", areaType: "suburban", business: PLANO_CITY_HALL },
    day: DAY,
    techs: [{ key: "solo", name: "Owner-operator", start: PLANO_CITY_HALL }],
    stops: planoStops.slice(0, 6),
    osrm: "fixture",
    fixture: "tiny",
  },
  {
    id: "edge-cases",
    title: "Edge cases: bad coordinates, duplicates, absent and odd technicians",
    question: "Every bad row a real import produces, on one day.",
    // No business location, so a tech with no start address falls to tier 4.
    org: { tz: "America/Chicago", areaType: "suburban", business: null },
    day: DAY,
    techs: [
      { key: "kim", name: "Kim", start: PLANO_CITY_HALL },
      { key: "lee", name: "Lee (no start, no business address)", start: null },
      { key: "max", name: "Max (off today)", start: [33.0, -96.72], offToday: true },
      { key: "ned", name: "Ned (part-time, 120 min)", start: [33.1, -96.68], capacityMin: 120 },
      {
        key: "owen",
        name: "Owen (office, not a field tech)",
        start: [33.02, -96.7],
        isFieldTech: false,
      },
    ],
    stops: edgeStops,
    osrm: "down",
  },
  {
    id: "bad-coordinates",
    title: "Bad coordinates: one 0,0 and one wrong-continent geocode among 8 good stops",
    question: "Does one bad row cost one stop, or the whole day?",
    org: { tz: "America/Chicago", areaType: "suburban", business: PLANO_CITY_HALL },
    day: DAY,
    techs: [
      { key: "kim", name: "Kim", start: PLANO_CITY_HALL },
      { key: "ned", name: "Ned", start: [33.1, -96.68] },
    ],
    stops: badCoordStops,
    osrm: "fixture",
    fixture: "bad-coordinates",
  },
  {
    id: "windows",
    title: "Time windows: 2 techs, 16 stops, 5 windows and a preference",
    question: "Are arrival windows honoured, and is a missed one reported?",
    org: { tz: "America/Chicago", areaType: "suburban", business: PLANO_CITY_HALL },
    day: DAY,
    techs: [
      { key: "cara", name: "Cara", start: [33.1507, -96.8236] },
      { key: "dev", name: "Dev", start: [32.9483, -96.7299] },
    ],
    stops: windowStops,
    osrm: "down",
  },
  {
    id: "overfull",
    title: "A day that does not fit: 1 tech, 40 stops x 15 min, 8-5 workday",
    question: "600 minutes of service in a 540-minute day. Is anyone told?",
    org: {
      tz: "America/Chicago",
      areaType: "suburban",
      workdayEnd: "17:00",
      business: PLANO_CITY_HALL,
    },
    day: DAY,
    techs: [{ key: "solo", name: "Solo Tech", start: PLANO_CITY_HALL, capacityMin: 480 }],
    // The 24 Plano stops plus 16 neighbours 400 m north of the first 16.
    stops: [...planoStops, ...planoStops.slice(0, 16)].map((p, i) => ({
      ...p,
      key: `${p.key}_${i}`,
      lat: (p.lat as number) + (i >= 24 ? 0.004 : 0),
      serviceMin: 15,
    })),
    osrm: "down",
  },
];

export const scenarioById = (id: string) => {
  const sc = SCENARIOS.find((x) => x.id === id);
  if (!sc) throw new Error(`no scenario ${id}`);
  return sc;
};
