// "Is there definitely no network right now?"
//
// ── WHY THIS IS NOT JUST navigator.onLine ─────────────────────────────────
//
// run-or-queue.ts settles the philosophy and it is not restated here: false is
// trustworthy, true is a guess, and a deadline rather than a flag is what keeps
// a tech's work from vanishing. This module changes nothing about that. It
// widens the set of cases where the answer is a trustworthy FALSE, on native
// only, and it can never widen the set where the answer is "online".
//
// The reason it is worth widening: in a WKWebView `navigator.onLine` is not
// refreshed reliably while the app is suspended, so a van that drove through a
// dead zone with the app backgrounded can resume reporting `onLine === true`
// against no connection at all. That is the exact moment this app most needs
// the honest answer, because it is when a tech opens the phone to close out a
// stop. @capacitor/network's listener fires on resume and reports the real
// interface state.
//
// ── THE SAFETY ARGUMENT FOR CHANGING OFFLINE-CRITICAL CODE ────────────────
//
// `definitelyOffline` ORs the two negatives. It can therefore only ever return
// true in MORE situations than `navigator.onLine === false` did, never fewer.
// Every caller treats true as "queue it locally and tell the tech", which is
// the safe direction: the worst case of a false positive is work recorded in
// the durable queue and replayed seconds later, and the worst case of a false
// negative is the hang QA-P4 was filed for.

/** Last thing the native listener said. `null` = never heard from, which is
 *  the correct state on web and before init on native. Deliberately not
 *  initialised to `true`: "no news" must not read as "connected". */
let nativeConnected: boolean | null = null;

/** Pure core, so the composition can be asserted without a device. */
export function definitelyOffline(input: {
  /** `navigator.onLine`, or undefined where there is no navigator. */
  browserOnLine: boolean | undefined;
  /** Native interface state, or null if unknown / not native. */
  nativeConnected: boolean | null;
}): boolean {
  if (input.browserOnLine === false) return true;
  if (input.nativeConnected === false) return true;
  return false;
}

/** What the offline-aware call sites use. */
export function isDefinitelyOffline(): boolean {
  return definitelyOffline({
    browserOnLine: typeof navigator === "undefined" ? undefined : navigator.onLine,
    nativeConnected,
  });
}

/** Test seam. Not exported for production use; the listener owns this value. */
export function __setNativeConnected(v: boolean | null): void {
  nativeConnected = v;
}

/**
 * Subscribe to native network changes. No-ops on web, where the browser's own
 * online/offline events already drive `navigator.onLine`.
 *
 * Returns an unsubscribe function.
 */
export async function initNativeConnectivity(): Promise<() => void> {
  const { isNative } = await import("@/lib/native");
  if (!isNative()) return () => {};
  const { Network } = await import("@capacitor/network");
  const status = await Network.getStatus();
  nativeConnected = status.connected;
  const handle = await Network.addListener("networkStatusChange", (s) => {
    nativeConnected = s.connected;
  });
  return () => {
    nativeConnected = null;
    void handle.remove();
  };
}
