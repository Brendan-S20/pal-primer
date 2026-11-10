// The app's ONE listener on Capacitor's `appUrlOpen` (#621).
//
// A link that opens a KILLED app is not an ordinary event. Capacitor holds
// it ("retainUntilConsumed") until something listens, and then hands it to
// THE FIRST LISTENER ONLY: Plugin.addEventListener on Android and CAPPlugin
// on iOS send retained events when the first listener for that event is
// added, then drop them. A second listener added a moment later never sees
// it. When the app is already running, every listener gets every event.
//
// There used to be two listeners. src/routes/__root.tsx listened for staff
// links (through initAppLinks in lib/native.ts), and src/routes/auth.tsx
// listened for the OAuth hand-back. On a cold start the launch redirects
// `/` to /auth, and /auth's listener is one dynamic import away while the
// root's is several (initBackButton, pending-deep-link, the Supabase client,
// then three more imports). So /auth attached first, was handed the launch
// link, saw that it was not an auth-callback and dropped it, and the root
// never heard of it. /auth then landed the tech on their role page, My Day,
// with its close-out prompt, which made the prompt look like the cause. A
// link to the running app worked, because by then both were listening.
//
// So there is one Capacitor listener here, and the JS side keeps the same
// promise Capacitor made: a URL nobody is listening for yet is kept for the
// first subscriber of ITS kind, not handed to whoever happens to be first.
//
//   - "path": one of our links that opens a page (an Android App Link, the
//     iPhone Live Activity link), already turned into an in-app path. The
//     root holds it in lib/pending-deep-link.ts.
//   - "other": anything else (the OAuth hand-back is the one that matters).
//     /auth reads it.
//
// Only the latest URL of each kind is kept: the last tap is the one meant,
// and a stale OAuth hand-back is not worth replaying twice.

export type AppUrlKind = "path" | "other";
type Listener = (value: string) => void;

const subscribers: Record<AppUrlKind, Set<Listener>> = {
  path: new Set(),
  other: new Set(),
};
const kept: Record<AppUrlKind, string | null> = { path: null, other: null };
let attached: Promise<void> | null = null;

/** Hand a URL to every subscriber of its kind, or keep it for the first. */
export function dispatchAppUrl(kind: AppUrlKind, value: string): void {
  const subs = subscribers[kind];
  if (subs.size === 0) {
    kept[kind] = value;
    return;
  }
  for (const fn of [...subs]) fn(value);
}

/** A URL of this kind that nobody has subscribed for yet, taken. /auth uses
 *  it at the moment it lands: on a cold start the launch link is usually
 *  already here, sorted, while the root is still importing its way to
 *  subscribing, and landing on My Day first would be the bug again. */
export function takeWaitingAppUrl(kind: AppUrlKind): string | null {
  const value = kept[kind];
  kept[kind] = null;
  return value;
}

/**
 * Sort one URL that opened the app. Exported (through loadClassifier) so it
 * can be tested without a device.
 *
 * A PASSWORD-RECOVERY link is sorted first, into a "path" to /reset-password
 * carrying its tokens. Two ways one arrives (2026-11-09):
 *
 *   - iOS: the reset was requested in the app, so Supabase hands back to the
 *     custom scheme, consulting.thenorth.houndstack://auth-callback#…
 *     &type=recovery. Treated as an OAuth hand-back, it became a session and
 *     /auth landed it (bootstrapping a workspace) without a new password.
 *   - Android: the root `/` is a claimed App Link, and the root is where
 *     Supabase sends a recovery whose redirect is not allow-listed. It came
 *     through as the path "/#access_token=…", which nothing read.
 *
 * /reset-password needs no session to open (lib/pending-deep-link.ts), so it
 * is pushed as soon as the router is idle, signed in or not, and the page
 * turns the tokens into a session itself.
 */
export async function loadClassifier(): Promise<(url: string) => [AppUrlKind, string]> {
  const [{ appLinkTarget }, { liveActivityLinkTarget }, recovery] = await Promise.all([
    import("@/lib/android-app-links"),
    import("@/lib/live-activity-links"),
    import("@/lib/password-recovery"),
  ]);
  return (url) => {
    const reset = recovery.recoveryForwardPath(url);
    if (reset) {
      recovery.markRecoveryPending();
      return ["path", reset];
    }
    const path = appLinkTarget(url) ?? liveActivityLinkTarget(url);
    return path ? ["path", path] : ["other", url];
  };
}

function attachOnce(): Promise<void> {
  if (!attached) {
    attached = (async () => {
      // Classifiers loaded BEFORE the listener goes on, so a retained launch
      // URL, delivered the moment it attaches, is sorted synchronously.
      const [{ App }, classify] = await Promise.all([import("@capacitor/app"), loadClassifier()]);
      // Never removed: it is the app's, not a screen's. Screens unsubscribe.
      await App.addListener("appUrlOpen", ({ url }) => {
        const [kind, value] = classify(url);
        dispatchAppUrl(kind, value);
      });
    })();
    attached.catch(() => {
      attached = null;
    });
  }
  return attached;
}

/**
 * Listen for one kind of URL that opens the app. A URL of that kind that
 * arrived before anyone listened for it (a cold-start link) is delivered
 * now. Returns the unsubscribe. Web: a no-op.
 */
export async function onAppUrl(kind: AppUrlKind, fn: Listener): Promise<() => void> {
  const { Capacitor } = await import("@capacitor/core");
  if (!Capacitor.isNativePlatform()) return () => {};
  subscribers[kind].add(fn);
  const waiting = kept[kind];
  kept[kind] = null;
  if (waiting !== null) fn(waiting);
  await attachOnce();
  return () => {
    subscribers[kind].delete(fn);
  };
}

/** Tests only. */
export function __resetAppUrlOpenForTests(): void {
  subscribers.path.clear();
  subscribers.other.clear();
  kept.path = null;
  kept.other = null;
  attached = null;
}
