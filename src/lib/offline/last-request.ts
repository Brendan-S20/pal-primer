// "Did the last request actually get through?"
//
// ── WHY (R2-53, Pixel, android-r2-09) ─────────────────────────────────────
//
// My Day's connection line read "Back online · 1 pending" while every request
// was failing. "Online" came from useOnline(), which asks the INTERFACE —
// navigator.onLine and @capacitor/network — and an interface can be up with
// nothing on the other end of it: a captive portal at a gas station, a phone
// on one bar of LTE, the API down (#622). connectivity.ts says so itself:
// "false is trustworthy, true is a guess." The line was presenting the guess
// as a fact, beside a pending count that was not going down.
//
// So the line now also reads what the last request that went out actually
// did. Recorded at the three places requests a tech is waiting on are made:
// runOrQueue (a field action), syncQueue (the replay) and My Day's own load.
// Only TRANSPORT failures count as "failed" — the server refusing an action
// is an answer, which means the server was reached.
//
// A module value plus a DOM event, the same shape as connectivity.ts, so a
// hook mounted after the outcome was recorded still reads it.

export type RequestOutcome = "ok" | "failed";

let last: RequestOutcome | null = null;

export const LAST_REQUEST_CHANGE = "offline-last-request-change";

export function recordRequestOutcome(outcome: RequestOutcome): void {
  if (last === outcome) return;
  last = outcome;
  if (typeof window !== "undefined") window.dispatchEvent(new Event(LAST_REQUEST_CHANGE));
}

export function lastRequestOutcome(): RequestOutcome | null {
  return last;
}

/** Test seam. */
export function __resetLastRequestOutcome(): void {
  last = null;
}

/**
 * What the connection line says, or null for no line.
 *
 *   offline      the device says there is no network (trustworthy);
 *   unreachable  the device says there is, and the last request did not get
 *                through — "Back online" here was the bug;
 *   online       the device says there is, and nothing has failed since.
 *
 * The line is drawn when the device is offline or something is queued, as
 * before; only what it SAYS changed. Pure, so it can be asserted.
 */
export function connectionLine(input: {
  online: boolean;
  pending: number;
  lastOutcome: RequestOutcome | null;
}): "offline" | "unreachable" | "online" | null {
  if (!input.online) return "offline";
  if (input.pending <= 0) return null;
  return input.lastOutcome === "failed" ? "unreachable" : "online";
}
