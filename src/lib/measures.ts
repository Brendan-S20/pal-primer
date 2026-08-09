// Distance and speed, converted at the edges.
//
// The routing model is metric all the way down: `organizations.avg_speed_kmh`,
// `visits.travel_km`, and `effective_speed_kmh()` in SQL. That is fine and is
// not what this file changes. What it changes is that those numbers were also
// being SHOWN to the operator, who runs a pet-waste business in the United
// States and does not think in kilometres.
//
// The two failures that came from it were different in kind:
//
//   A LABEL that lies. `findRouteWarnings` printed "1,850 km" in a warning
//   about a stop being too far away. Wrong units in a message is a reading
//   problem — the dispatcher is told the wrong-sized number and has to
//   convert it, or quietly mis-scales the problem.
//
//   AN INPUT that lies, which is worse. Settings offered "Average speed
//   (km/h)" bound straight to the stored column. An American dispatcher types
//   the number they know — 25, meaning miles per hour — and the ETA engine
//   reads 25 km/h, which is 15.5 mph. Every arrival time in the app is then
//   about 60% too slow, and nothing anywhere reports an error. This is the
//   reason a units pass cannot be done with a find-and-replace on labels: the
//   input needed a conversion, and the label alone would have made it worse.
//
// Nothing here touches storage. Kilometres stay in the database; the
// conversion happens at the last moment before a person reads it and the
// first moment after a person types it.
//
// (Not to be confused with `units.functions.ts`, which is about apartment
// units in a commercial property — an unfortunate collision of the word.)

/** Kilometres in one mile. */
export const KM_PER_MILE = 1.609344;

export function kmToMiles(km: number): number {
  return km / KM_PER_MILE;
}

export function milesToKm(miles: number): number {
  return miles * KM_PER_MILE;
}

/** Miles per hour, rounded, from a stored km/h figure.
 *
 *  Paired with `mphToStoredKmh` so that a value shown to someone and then
 *  written back unchanged survives the round trip. Across the range the
 *  settings input allows, `mphToStoredKmh(mphFromStoredKmh(k))` differs from
 *  `k` by at most the rounding of a single conversion, and
 *  `mphFromStoredKmh(mphToStoredKmh(m)) === m` exactly — which is what stops a
 *  dispatcher from changing their own routing model by tabbing through a
 *  field they did not edit. */
export function mphFromStoredKmh(kmh: number): number {
  return Math.round(kmToMiles(kmh));
}

/** The km/h to store for a speed someone typed in mph. */
export function mphToStoredKmh(mph: number): number {
  return Math.round(milesToKm(mph));
}

/** Bounds for the settings input, in mph.
 *
 *  The server and the RPC both guard `avg_speed_kmh` to 5..120, and these are
 *  the widest mph bounds that stay inside it: 3 mph stores as 5 km/h and
 *  74 mph as 119. One step out on either side leaves the window — 2 mph is
 *  3 km/h and 75 mph is 121 — and a browser that accepts a number the server
 *  then rejects is a form that fails on save with nothing to read.
 *
 *  Neither end is a plausible driving speed. They are here to agree with the
 *  server, not to express an opinion about how fast a truck moves. */
export const MIN_SPEED_MPH = 3;
export const MAX_SPEED_MPH = 74;
