// Getting back to the live app when the API comes back, without a reload.
//
// ── THE CASE ──────────────────────────────────────────────────────────────
//
// #622: the phone has a network but the API does not answer (down, a gateway
// 502/503, a DNS failure). resolveIdentity() reads that the same as offline
// and answers from the device, so the shell draws the saved My Day instead
// of the sign-in form. That is half the fix. The other half is noticing when
// the API is back. Nothing else does: the device never went offline, so no
// `online` event fires and @capacitor/network reports no change. Without this
// the tech would sit on a saved copy until they killed the app.
//
// ── WHAT IT DOES ──────────────────────────────────────────────────────────
//
// While the shell is drawn from an unverified identity, ask again on a
// backoff (RECOVERY_DELAYS_MS, then every last delay), and at once when the
// device says it reconnected or the app comes back to the foreground. Never
// while the device is definitely offline: that request can only wait.
//
// The first answer from the auth server ends it, yes or no. The caller then
// re-runs the shell's checks, which either draw the live app (yes) or take
// the person to /auth because the server refused the session (no). A no is
// the only way this ever leads to a sign-in form, and it is one the server
// gave, not one guessed from a dead connection.

import { CONNECTIVITY_CHANGE } from "@/lib/offline/connectivity";

export type ApiProbeResult = "verified" | "rejected" | "unreachable";

/** Fast at first (a blip), settling at half a minute (an outage). */
export const RECOVERY_DELAYS_MS = [3_000, 6_000, 12_000, 20_000, 30_000] as const;

/** One probe may take this long. Past it, the probe counts as unreachable
 *  and the loop goes on. On the web build getUser() has no deadline of its
 *  own and can wait on the auth lock behind a refresh that is retrying; a
 *  probe that never settles would otherwise stop this loop for good, since
 *  the next ask only happens after the last one answered. */
export const PROBE_DEADLINE_MS = 10_000;

/** Broadcast once the API has answered again, so work that waits on it (the
 *  offline queue's replay) can go at once rather than at the next reconnect,
 *  which in this case never comes. */
export const API_RETURNED = "offline-api-returned";

interface Target {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

interface DocumentLike {
  visibilityState?: string;
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}

export function startApiRecovery(opts: {
  probe: () => Promise<ApiProbeResult>;
  onAnswer: (result: "verified" | "rejected") => void;
  isOffline: () => boolean;
  target: Target;
  doc?: DocumentLike;
}): () => void {
  const { probe, onAnswer, isOffline, target, doc } = opts;
  let stopped = false;
  let inFlight = false;
  let attempt = 0;
  let timer: unknown = null;

  const schedule = () => {
    if (stopped) return;
    if (timer !== null) target.clearTimeout(timer);
    const delay = RECOVERY_DELAYS_MS[Math.min(attempt, RECOVERY_DELAYS_MS.length - 1)];
    attempt += 1;
    timer = target.setTimeout(() => {
      timer = null;
      void ask();
    }, delay);
  };

  const ask = async () => {
    if (stopped || inFlight) return;
    if (isOffline()) return schedule();
    inFlight = true;
    let result: ApiProbeResult = "unreachable";
    let deadline: unknown = null;
    try {
      result = await Promise.race([
        probe(),
        new Promise<ApiProbeResult>((resolve) => {
          deadline = target.setTimeout(() => resolve("unreachable"), PROBE_DEADLINE_MS);
        }),
      ]);
    } catch {
      result = "unreachable";
    } finally {
      if (deadline !== null) target.clearTimeout(deadline);
    }
    inFlight = false;
    if (stopped) return;
    if (result === "unreachable") return schedule();
    stop();
    onAnswer(result);
  };

  const now = () => void ask();
  const onVisible = () => {
    if (doc?.visibilityState === "visible") void ask();
  };

  target.addEventListener("online", now);
  target.addEventListener(CONNECTIVITY_CHANGE, now);
  doc?.addEventListener("visibilitychange", onVisible);
  schedule();

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer !== null) target.clearTimeout(timer);
    target.removeEventListener("online", now);
    target.removeEventListener(CONNECTIVITY_CHANGE, now);
    doc?.removeEventListener("visibilitychange", onVisible);
  }
  return stop;
}
