// Recording that somebody used the app, which is what a billing seat is
// (seat-rule.ts). The database decides everything that matters -- who the
// caller is, whether this is an impersonation or platform-admin session,
// whether they are active staff, whether today is already recorded -- in
// note_staff_seen() (20261009130000_a-seat-is-somebody-who-showed-up.sql).
// This file only gets the call made, cheaply, from the paths every working
// session takes:
//
//   * getMyOrg, which the signed-in layout's beforeLoad and useMyRole() call
//     on every launch and every minute or so after, web and native alike;
//   * noteMySighting, which the offline queue calls after it replays work, so
//     a tech whose day was spent in a dead zone is counted when it lands.
//
// It never throws, and never talks to Stripe.

import { sessionIdFromAuthHeader } from "@/lib/impersonation-marker";

export type SightingResult = {
  stamped: boolean;
  why?: string;
  organization_id?: string;
};

// One call per session per isolate per quarter hour. The database already
// writes at most once a day; this only spares it the read. Short enough that
// a renewal crossed mid-session is noticed soon after.
const THROTTLE_MS = 15 * 60_000;
const THROTTLE_MAX = 2_000;
const lastAsked = new Map<string, number>();

/** Test seam. */
export function __clearSightingThrottle() {
  lastAsked.clear();
}

/** Whether this session asked recently enough to skip asking again. Records
 *  the ask when it does not skip. */
export function throttled(key: string, now: number = Date.now()): boolean {
  const at = lastAsked.get(key);
  if (at !== undefined && now - at < THROTTLE_MS) return true;
  if (lastAsked.size >= THROTTLE_MAX) {
    for (const [k, v] of lastAsked) if (now - v >= THROTTLE_MS) lastAsked.delete(k);
    if (lastAsked.size >= THROTTLE_MAX) lastAsked.clear();
  }
  lastAsked.set(key, now);
  return false;
}

async function currentSessionKey(userId: string): Promise<string> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const sid = sessionIdFromAuthHeader(getRequest()?.headers?.get("authorization"));
    return `${userId}:${sid ?? "-"}`;
  } catch {
    return `${userId}:-`;
  }
}

/**
 * The Worker's waitUntil for this request, if it has one (see
 * routing-runs.functions.ts for where Nitro puts it). Without one (Node in
 * dev, vitest) the job simply runs on.
 */
async function keepAlive(): Promise<(job: Promise<unknown>) => void> {
  try {
    const { getRequest } = await import("@tanstack/react-start/server");
    const request = getRequest() as
      (Request & { waitUntil?: (p: Promise<unknown>) => void }) | null;
    const waitUntil = request?.waitUntil;
    if (typeof waitUntil === "function") {
      return (job) => {
        try {
          waitUntil.call(request, job);
        } catch {
          /* the job runs regardless */
        }
      };
    }
  } catch {
    /* not inside a request */
  }
  return () => {};
}

/**
 * Record the caller's sighting with THEIR OWN client (the function reads
 * auth.uid() and the JWT's session id, so it can only ever stamp the caller).
 * Nothing is sent to Stripe here: a seat period is charged after it closes
 * (seat-reconcile.server.ts).
 */
export async function noteStaffSeen(
  supabase: unknown,
  userId: string,
  opts: { force?: boolean } = {},
): Promise<SightingResult | null> {
  try {
    const key = await currentSessionKey(userId);
    if (!opts.force && throttled(key)) return null;

    // Not in the generated types yet; the shape is note_staff_seen()'s jsonb.
    const { data, error } = await (
      supabase as {
        rpc: (fn: "note_staff_seen") => PromiseLike<{
          data: unknown;
          error: { message: string } | null;
        }>;
      }
    ).rpc("note_staff_seen");
    if (error) {
      console.error("note_staff_seen failed", error.message);
      return null;
    }
    const r = (data ?? { stamped: false }) as SightingResult;
    return r;
  } catch (e) {
    console.error("recording a sighting failed", (e as Error).message);
    return null;
  }
}

/** Fire-and-forget form for a path that must not wait: the sighting runs on
 *  the Worker's waitUntil and the caller returns at once. */
export function noteStaffSeenInBackground(supabase: unknown, userId: string): void {
  const job = noteStaffSeen(supabase, userId).catch(() => null);
  void keepAlive().then((extend) => extend(job));
}
