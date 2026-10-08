// When the route goes back on the lock screen by itself.
//
// Until 2026-10-08 it started only on a TRANSITION seen on My Day -- Clock in,
// or the first Start -- and never on opening the app, so a tech who swiped
// it away was not handed it back. After a day on TestFlight the owner asked
// for the opposite: open the app (or bring it back to the front) in the
// middle of a working day and the route is on the lock screen again, without
// looking for a switch. The switch on Preferences, "Route on the lock
// screen", is the one way to say no, and it is respected every time.
//
// One pure function, so the cases are a table in
// tests/the-route-comes-back-by-itself.test.ts rather than a reading of a
// React effect.

export type RouteAutoStartInput = {
  /** This phone can show one and Live Activities are on for the app. */
  supported: boolean;
  /** The Preferences switch, once storage has been read. Null until then:
   *  a phone that said no would read as yes for one frame. */
  preferenceOn: boolean | null;
  /** Today's route, as worked (queued taps applied). */
  visits: readonly { status: string }[];
  /** On the clock now (queued taps applied). Null when unknown, or for an
   *  account with no clock. */
  onClock: boolean | null;
  /** Off the clock now, after time on it today: the tech clocked out. That
   *  ends the route, and the route stays ended until they clock back in,
   *  however many stops are left. */
  clockedOutToday: boolean;
  /** A route activity is already up. */
  showing: boolean;
  /** A start or end is in flight. */
  busy: boolean;
};

/** Still to do: a stop that is waiting or under way. */
const LEFT = new Set(["scheduled", "in_progress"]);
/** The day has begun: a stop under way, or one already done or skipped. */
const BEGUN = new Set(["in_progress", "completed", "skipped"]);

export function routeHasWorkLeft(visits: readonly { status: string }[]): boolean {
  return visits.some((v) => LEFT.has(v.status));
}

export function routeDayHasBegun(visits: readonly { status: string }[]): boolean {
  return visits.some((v) => BEGUN.has(v.status));
}

/**
 * Put the route on the lock screen now? Yes when all of these hold:
 *   * the phone can, and the Preferences switch is on (read, not assumed);
 *   * there is a stop left today, so never for a finished or empty day;
 *   * the tech is on the clock, OR the day has begun (a stop started,
 *     finished or skipped) and they have not clocked out today, so a day
 *     the tech has not touched stays off the lock screen until they clock in
 *     or press Start, and a clock-out is not undone by opening the app;
 *   * nothing is showing and nothing is already being started.
 */
export function shouldStartRouteActivity(i: RouteAutoStartInput): boolean {
  if (!i.supported || i.preferenceOn !== true) return false;
  if (i.showing || i.busy) return false;
  if (!routeHasWorkLeft(i.visits)) return false;
  if (i.onClock === true) return true;
  return !i.clockedOutToday && routeDayHasBegun(i.visits);
}
