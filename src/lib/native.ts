// Runtime helpers that gracefully no-op on web and use Capacitor natively.
import { Capacitor } from "@capacitor/core";
import { FCM_CONFIGURED } from "@/lib/native-build";

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

export async function hapticImpact(style: "light" | "medium" | "heavy" = "light") {
  if (!isNative()) return;
  const { Haptics, ImpactStyle } = await import("@capacitor/haptics");
  const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
  await Haptics.impact({ style: map[style] });
}

export async function hapticSuccess() {
  if (!isNative()) return;
  const { Haptics, NotificationType } = await import("@capacitor/haptics");
  await Haptics.notification({ type: NotificationType.Success });
}

export async function takePhotoNative(): Promise<Blob | null> {
  if (!isNative()) return null;
  const { Camera, CameraResultType, CameraSource } = await import("@capacitor/camera");
  const photo = await Camera.getPhoto({
    quality: 80,
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,
    correctOrientation: true,
  });
  if (!photo.webPath) return null;
  const res = await fetch(photo.webPath);
  return await res.blob();
}

/**
 * A position fix on a native device, or the REASON there isn't one.
 *
 * This replaces an earlier `getCurrentPositionNative` that returned
 * `GeolocationPosition | null` and had zero callers. Null could not be wired
 * to anything useful: the caller has to tell "the tech declined" from "no sky"
 * from "not native, use the browser", and all three arrived as null.
 *
 * Permission is CHECKED rather than inferred from a thrown error. The plugin
 * rejects with a plain message on iOS, so matching text would be guessing at a
 * string Apple can change; `checkPermissions()` reports the state directly.
 *
 * Returns null — and only null — when this is not a native build, which is the
 * signal for the caller to take its existing browser path.
 */
export type NativePosition =
  | { ok: true; latitude: number; longitude: number; accuracy: number }
  | { ok: false; reason: "denied" | "unavailable" | "timeout" };

export async function getPositionNative(): Promise<NativePosition | null> {
  if (!isNative()) return null;
  const { Geolocation } = await import("@capacitor/geolocation");

  let status = await Geolocation.checkPermissions();
  if (status.location === "prompt" || status.location === "prompt-with-rationale") {
    // Only ask when the OS says asking is still possible. Calling
    // requestPermissions() after a denial is a no-op that returns 'denied'
    // again, and on iOS the system prompt never reappears — the way back is
    // Settings, which is what the caller's message says.
    status = await Geolocation.requestPermissions({ permissions: ["location"] });
  }
  if (status.location !== "granted") return { ok: false, reason: "denied" };

  try {
    const p = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: 10_000,
      maximumAge: 30_000,
    });
    return {
      ok: true,
      latitude: p.coords.latitude,
      longitude: p.coords.longitude,
      accuracy: p.coords.accuracy,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: /time.?out/i.test(msg) ? "timeout" : "unavailable" };
  }
}

/**
 * Follow the device's position on a native build, for the "on my way" live
 * map (src/hooks/useShareLocationEnRoute.ts). Returns a function that stops
 * watching, or null when this is not a native build — the caller's signal to
 * use navigator.geolocation instead.
 *
 * Foreground only, deliberately: this is the plain Capacitor plugin, not a
 * background-location service. When the app is not on screen the OS stops
 * delivering fixes, which is the privacy rule ("only while the tech's app is
 * open") rather than a gap in it. Permission is checked the same way as
 * getPositionNative above, and a denial arrives as onError("denied").
 */
export async function watchPositionNative(
  onPosition: (p: { latitude: number; longitude: number; accuracy: number }) => void,
  onError: (reason: "denied" | "unavailable") => void,
): Promise<(() => void) | null> {
  if (!isNative()) return null;
  const { Geolocation } = await import("@capacitor/geolocation");

  let status = await Geolocation.checkPermissions();
  if (status.location === "prompt" || status.location === "prompt-with-rationale") {
    status = await Geolocation.requestPermissions({ permissions: ["location"] });
  }
  if (status.location !== "granted") {
    onError("denied");
    return () => {};
  }

  const id = await Geolocation.watchPosition(
    { enableHighAccuracy: true, timeout: 20_000, maximumAge: 15_000 },
    (pos, err) => {
      if (err || !pos) {
        onError("unavailable");
        return;
      }
      onPosition({
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
      });
    },
  );
  return () => {
    void Geolocation.clearWatch({ id });
  };
}

/** The Android notification channel push arrives on. `id` must equal
 *  `default_notification_channel_id` in android/app/src/main/res/values/strings.xml.
 *  Importance 4 (high) shows a heads-up banner, which is what iOS does with
 *  the `alert` presentation option in capacitor.config.ts. */
export const ANDROID_PUSH_CHANNEL = {
  id: "general",
  name: "HoundStack",
  description: "Route changes, new jobs and messages",
  importance: 4 as const,
  visibility: 1 as const,
};

/** The APNs/FCM token this device registered in THIS session, so sign-out can
 *  release it. Memory only: registration runs on every launch of the signed-in
 *  shell, so a session that has a token to release always set this first. */
let registeredPushToken: string | null = null;

/** Where this device stands on notifications, in the four states a person can
 *  do something different about:
 *
 *    prompt       iOS (or Android) will still ask. A tap can bring the prompt up.
 *    granted      On. The token is registered on every launch.
 *    denied       Answered no. iOS never asks again; the way back is Settings.
 *    unavailable  This build cannot do push at all (Android without a Firebase
 *                 config; see the guard in registerPush below).
 *
 *  `prompt-with-rationale` is Android's "asked once, may ask once more", which
 *  for the person is still "a tap will ask", so it folds into `prompt`. */
export type PushPermission = "prompt" | "granted" | "denied" | "unavailable";

function permissionFrom(receive: string): PushPermission {
  if (receive === "granted") return "granted";
  if (receive === "prompt" || receive === "prompt-with-rationale") return "prompt";
  return "denied";
}

/** True for a build where calling the push plugin's register() would crash
 *  the app rather than fail. See the long note in registerPush. */
function pushCannotInitialise(): boolean {
  return platform() === "android" && !FCM_CONFIGURED;
}

/**
 * The current notification permission, WITHOUT asking. Null on web, where
 * PushToggle and the browser's own permission are the whole story.
 *
 * For Settings → Preferences, which has to draw the right control before the
 * person touches anything.
 */
export async function getPushPermission(): Promise<PushPermission | null> {
  if (!isNative()) return null;
  if (pushCannotInitialise()) return "unavailable";
  const { PushNotifications } = await import("@capacitor/push-notifications");
  return permissionFrom((await PushNotifications.checkPermissions()).receive);
}

/** Said once per app launch, not once per call: the shell runs registration on
 *  every mount of the signed-in layout, and the Preferences button can run it
 *  again. A person who said no is a fact about this launch, not an event to
 *  count. */
let reportedNotGranted = false;

/** And once per PHONE per answer, across launches. Once per launch was still
 *  one warning every time a tech who said no opened the app, which is noise
 *  that spends the monitoring quota and says nothing new. The first report on
 *  2026-10-04 (HOUNDSTACK-3, denied/not_asked) answered its question once;
 *  the next thousand would not have. A granted answer clears it, so a phone
 *  that later turns notifications off again is reported again. Device-local:
 *  wrapped, because storage can be unavailable, and a failure here must never
 *  stop registration. */
const REPORTED_PERMISSION_KEY = "houndstack.push.reportedPermission";

function alreadyReportedOnThisPhone(state: string): boolean {
  try {
    return window.localStorage.getItem(REPORTED_PERMISSION_KEY) === state;
  } catch {
    return false;
  }
}

function rememberReportedOnThisPhone(state: string | null) {
  try {
    if (state === null) window.localStorage.removeItem(REPORTED_PERMISSION_KEY);
    else window.localStorage.setItem(REPORTED_PERMISSION_KEY, state);
  } catch {
    // Unavailable storage means at worst one warning per launch, as before.
  }
}

/** The listeners of the registration that is current on this device. One set
 *  at a time: the shell makes one on launch and the Preferences button makes
 *  one when it turns notifications on, and two `registration` listeners would
 *  save the same token twice. Whichever call comes second replaces the first,
 *  and the shell's teardown (sign-out) removes whichever is current. */
let activeListeners: (() => void) | null = null;

function stopPushListeners() {
  const stop = activeListeners;
  activeListeners = null;
  stop?.();
}

/**
 * Ask for notification permission and register this device for push.
 *
 * WHEN: called from the signed-in shell (src/routes/_authenticated/route.tsx),
 * never from the root — so the system prompt appears after sign-in, when the
 * token has a user to belong to, and never on the sign-in screen of a fresh
 * install. After the first answer iOS never shows the prompt again; later
 * launches only re-register, which is how a rotated token reaches the server.
 * The "Notifications on this phone" card in Settings → Preferences calls it
 * too, through turnOnPushNotifications, for a person who wants to answer now.
 *
 * TOKEN REFRESH: APNs can hand out a new token (restore from backup, reinstall,
 * OS update). `register()` runs on every launch and the `registration` event
 * delivers whatever the token is NOW, so a changed one is saved within one
 * launch; the stale row is switched off by the server the first time APNs
 * answers 410 for it.
 *
 * REPORTED (lib/monitoring/client.ts, off in dev and tests): APNs refusing to
 * issue a token, and, once per launch, a permission that did not end up
 * granted. Not the granted path, which is every launch of every phone that
 * works. Until 2026-10-04 both of those went to console.warn or nowhere, on a
 * phone, so an owner who never saw the prompt left no trace at all.
 *
 * Returns a cleanup that removes the listeners.
 */
export async function registerPushNotifications(
  onToken: (token: string) => void,
): Promise<() => void> {
  return (await registerPush(onToken)).cleanup;
}

async function registerPush(
  onToken: (token: string) => void,
): Promise<{ permission: PushPermission | null; cleanup: () => void }> {
  if (!isNative()) return { permission: null, cleanup: () => {} };

  // ── ANDROID WITHOUT A FIREBASE CONFIG CRASHES, IT DOES NOT DEGRADE ──────
  //
  // `register()` below reaches FirebaseMessaging.getInstance(), which throws
  // "Default FirebaseApp is not initialized in this process" when
  // android/app/google-services.json is missing. It is raised on the native
  // CapacitorPlugins thread, so the `await` NEVER REJECTS -- the exception is
  // uncaught and the process dies. Wrapping this in try/catch does nothing;
  // that was checked, not assumed.
  //
  // Measured on an emulator 2026-09-15: grant the notification permission and
  // the app is killed on launch, deterministically. Deny it and nothing happens,
  // because the permission check below returns first -- so the crash lands on
  // exactly the users who say yes, which is why no test ever saw it.
  //
  // FCM_CONFIGURED is build-time and maintains itself: drop the real
  // google-services.json into android/app/ and this switches back on at the next
  // build with no code change here. iOS is untouched -- it reaches APNs without
  // Firebase, where a missing key means push quietly does not arrive.
  if (pushCannotInitialise()) {
    console.warn(
      "[push] android/app/google-services.json is absent, so FCM cannot initialise. " +
        "Skipping push registration: calling it would crash the app, not fail softly.",
    );
    return { permission: "unavailable", cleanup: () => {} };
  }

  const { PushNotifications } = await import("@capacitor/push-notifications");
  // Check first and only ASK while asking is still possible. After a denial
  // requestPermissions() is a silent no-op on iOS; the way back is Settings.
  const before = (await PushNotifications.checkPermissions()).receive;
  let after = before;
  if (before === "prompt" || before === "prompt-with-rationale") {
    after = (await PushNotifications.requestPermissions()).receive;
  }
  const permission = permissionFrom(after);
  if (permission !== "granted") {
    // Which of the two it was is the whole question when a phone has no row
    // in push_subscriptions: `asked` is "the prompt was shown and the answer
    // was no", `not_asked` is "iOS had an answer before this launch and the
    // prompt could not appear". Warning, not error: a person saying no is the
    // product working, and it should be countable, not alarming.
    if (!reportedNotGranted && !alreadyReportedOnThisPhone(after)) {
      reportedNotGranted = true;
      rememberReportedOnThisPhone(after);
      const { reportClientIssue } = await import("@/lib/monitoring/client");
      reportClientIssue(
        "Push permission not granted",
        {
          area: "native_push",
          step: "permission",
          push_permission: after,
          push_prompt: permissionFrom(before) === "prompt" ? "asked" : "not_asked",
        },
        "warning",
      );
    }
    return { permission, cleanup: () => {} };
  }
  rememberReportedOnThisPhone(null);

  stopPushListeners();
  // Listeners BEFORE register(), not after. On iOS register() resolves at
  // once and the token arrives later through AppDelegate, and the plugin does
  // not retain a `registration` event for a listener that is not there yet —
  // a fast token on a warm launch was a token nobody heard.
  const onRegistration = await PushNotifications.addListener("registration", (t) => {
    registeredPushToken = t.value;
    onToken(t.value);
  });
  const onError = await PushNotifications.addListener("registrationError", (e) => {
    // Most often: the build is not signed with the aps-environment
    // entitlement (see docs/ios-build.md › Push notifications). That one
    // reads "no valid 'aps-environment' entitlement string found for
    // application", and it is the message that says which link is broken,
    // so it is sent as written; the scrubber in policy.ts runs over it first.
    console.warn("[push] registration failed", e.error);
    void import("@/lib/monitoring/client").then(({ reportClientIssue }) =>
      reportClientIssue(
        `Push registration failed: ${e.error}`,
        { area: "native_push", step: "registration_error" },
        "error",
      ),
    );
  });
  const remove = () => {
    void onRegistration.remove();
    void onError.remove();
  };
  activeListeners = remove;
  if (platform() === "android") {
    // Before register(), so the channel exists before the first message can.
    // AndroidManifest.xml names this id as FCM's default channel; without it
    // Firebase files everything under one it calls "Miscellaneous", which is
    // what the user would then see in Settings > Notifications. Idempotent:
    // Android ignores a create for an id that exists, and keeps the user's
    // own choices for it.
    try {
      await PushNotifications.createChannel(ANDROID_PUSH_CHANNEL);
    } catch {
      // A missing channel degrades to the fallback one; never block push on it.
    }
  }
  await PushNotifications.register();
  return { permission, cleanup: stopPushListeners };
}

/**
 * Turn notifications on for this device: ask if asking is still possible,
 * register, and save the token to the signed-in user. The ONE path both
 * callers take — the signed-in shell on every launch, and the "Notifications
 * on this phone" button in Settings → Preferences — so a token reaches
 * push_subscriptions the same way whichever of them got it.
 *
 * `isCancelled` is the shell's: a token that arrives after the shell has
 * unmounted (sign-out mid-registration) belongs to nobody and is not saved.
 *
 * Returns where permission ended up (null on web) and the cleanup. The
 * Preferences button ignores the cleanup on purpose: the token may arrive
 * after the person has left the page, and the shell's own teardown removes
 * the listeners on sign-out.
 */
export async function turnOnPushNotifications(
  opts: { isCancelled?: () => boolean } = {},
): Promise<{ permission: PushPermission | null; cleanup: () => void }> {
  return registerPush(async (token) => {
    if (opts.isCancelled?.()) return;
    try {
      const { subscribeStaffNativePush } = await import("@/lib/push.functions");
      await subscribeStaffNativePush({
        data: {
          token,
          platform: platform() === "ios" ? "ios" : "android",
          userAgent: navigator.userAgent,
        },
      });
    } catch (e) {
      // The token was minted and the server would not keep it: the exact
      // shape of "push_subscriptions has no row for this phone", so it is
      // reported rather than left on a console nobody can read.
      console.warn("native push register failed", e);
      const { reportClientError } = await import("@/lib/monitoring/client");
      reportClientError(e, { area: "native_push", step: "save_token" });
    }
  });
}

/**
 * Open this app's own page in iOS Settings, where Notifications is a switch.
 *
 * `app-settings:` is the value of UIApplication.openSettingsURLString. Nothing
 * in this app calls UIApplication directly; it does not need to. Capacitor's
 * WKWebView navigation handler (node_modules/@capacitor/ios/Capacitor/
 * Capacitor/WebViewDelegationHandler.swift, decidePolicyFor navigationAction)
 * hands every top-level navigation that is not the app's own origin and not in
 * allowNavigation to `UIApplication.shared.open(navURL)` and cancels it in the
 * WebView. `app-settings:` has no host and is not capacitor://localhost, so it
 * goes to the system, which opens Settings › HoundStack. No plugin in this
 * build overrides shouldOverrideLoad to intercept it first.
 *
 * iOS only. Android's Bridge.launchIntent would build an ACTION_VIEW intent for
 * a scheme no activity handles, so the Android card says where to go in words
 * instead. Returns whether it tried.
 */
export function openAppNotificationSettings(): boolean {
  if (!isNative() || platform() !== "ios") return false;
  window.location.href = "app-settings:";
  return true;
}

/** For tests: forget that this launch already reported a refusal. */
export function resetPushReportingForTests() {
  reportedNotGranted = false;
  rememberReportedOnThisPhone(null);
  activeListeners = null;
}

/**
 * Sign-out half of the above: delete this device's token from the signed-out
 * user's subscriptions, so a shared crew iPad stops buzzing with the previous
 * tech's notifications. Best-effort and bounded — a sign-out must never wait
 * on it, and the next user's registration reassigns the token anyway.
 * Must run while the session is still valid. No-op on web.
 */
export async function releasePushRegistration(timeoutMs = 3000): Promise<void> {
  const token = registeredPushToken;
  if (!isNative() || !token) return;
  registeredPushToken = null;
  try {
    const { unsubscribeStaffNativePush } = await import("@/lib/push.functions");
    await Promise.race([
      unsubscribeStaffNativePush({ data: { token } }),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Offline sign-out. The row stays until the next user on this device
    // registers, which moves it to them.
  }
}

/**
 * Take the splash down now, because the web app has painted.
 *
 * `capacitor.config.ts` used to leave this entirely to `launchShowDuration`,
 * and the plugin said so on every single launch:
 *
 *   SplashScreen.hideSplash: SplashScreen was automatically hidden after
 *   default timeout. You should call `SplashScreen.hide()` as soon as your web
 *   app is loaded (or increase the timeout).
 *
 * A timer cannot know whether the bundle has rendered, so it guessed, and it
 * guessed short: iOS QA 2026-08-20 measured the cream splash ending 5.3
 * seconds before the app painted, leaving a blank white screen in between —
 * on the very first thing a new user sees. `docs/ios-build.md` had already
 * written down that this would be the moment the programmatic API was needed.
 *
 * The duration in the config is now a BACKSTOP rather than the mechanism: if
 * this call never happens the splash still goes away, because a splash that
 * never lifts is worse than the gap it was meant to cover.
 */
export async function hideSplashScreen() {
  if (!isNative()) return;
  try {
    const { SplashScreen } = await import("@capacitor/splash-screen");
    await SplashScreen.hide();
  } catch {
    // Never let cosmetics fail a boot. The config backstop still fires.
  }
}

export async function initStatusBar() {
  if (!isNative()) return;
  const { StatusBar, Style } = await import("@capacitor/status-bar");
  // Match the rendered app theme, not the (dark) splash. The staff app ships
  // light-themed — dark mode is opt-in via a `.dark` root class — so pick the
  // icon style from the actual document state: Style.Light = dark icons for a
  // light background; Style.Dark = light icons for a dark background.
  const dark =
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  if (platform() === "android") {
    try {
      await StatusBar.setBackgroundColor({ color: dark ? "#0F172A" : "#FFFFFF" });
    } catch {
      // Overlay mode / older WebView — cosmetic only, never fatal.
    }
  }
}

// ── THE ANDROID BACK BUTTON ──────────────────────────────────────────────
//
// Android users press back to get rid of whatever is on top, and only then to
// go back a screen. So, in order:
//
//   1. An open dialog, sheet, drawer, popover or menu closes. Every one of
//      them in this app is Radix (or vaul, which is Radix Dialog), and Radix
//      closes the topmost layer on Escape, so back sends Escape. That also
//      reaches the hand-rolled panels that listen for Escape on window
//      (AutoRoutingPanel, KeyboardShortcuts). A dialog that REFUSES to close
//      (Radix's onEscapeKeyDown calling preventDefault, the way an
//      unsaved-changes guard would) keeps the screen too: back does nothing,
//      which is what that dialog asked for. One that IGNORES Escape entirely
//      (the guided tour) does not trap the user: back carries on to step 2.
//   2. Not on a start screen and there is history: go back one entry.
//   3. Otherwise the app goes to the background. Not exitApp(): that tears
//      the WebView down and a cold start costs the splash, the bundle and the
//      session restore. Backgrounding at the root is what Android 12+ does
//      for every app's launcher activity anyway.
//
// Why START screens and not just "is there history": a sign-in pushes the
// landing page on top of /auth, so from the dashboard "back" would go to
// /auth, which sees a session and sends you straight back to the dashboard.
// The button would appear dead on the one screen people press it most. The
// landing pages are the screens people start from, so they are where back
// leaves. A list rather than a guess at the user's landing page, because the
// landing page differs by role (src/routes/auth.tsx lookupLandingPath) and
// every one of them is here. The cost, accepted: an owner who opens /routes
// from the dashboard and presses back leaves the app rather than returning,
// because /routes is also a dispatcher's start screen.

/** Screens back leaves the app from: the sign-in flow, and every role's
 *  landing page (owner /dashboard, tech /my-day, dispatcher /routes,
 *  operator /platform). */
export const BACK_ROOT_PATHS: ReadonlySet<string> = new Set([
  "/",
  "/auth",
  "/sign-up",
  "/two-step",
  "/reset-password",
  "/no-workspace",
  "/dashboard",
  "/my-day",
  "/routes",
  "/platform",
]);

/** A customer portal's home: /portal/<slug>/<token>. */
const PORTAL_HOME = /^\/portal\/[^/]+\/[^/]+\/?$/;

export function isBackRoot(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return BACK_ROOT_PATHS.has(p) || PORTAL_HOME.test(pathname);
}

/** Open layers, in document order. Radix portals append to <body>, so the
 *  last one is the one on top. `data-state="closed"` is a layer mid-exit
 *  animation or force-mounted while shut; it is not open. */
const OPEN_LAYER = [
  '[role="dialog"]:not([data-state="closed"])',
  '[role="alertdialog"]:not([data-state="closed"])',
  "[data-radix-popper-content-wrapper]",
].join(",");

export function topmostOpenLayer(doc: Document): Element | null {
  const all = doc.querySelectorAll(OPEN_LAYER);
  return all.length ? all[all.length - 1] : null;
}

const stillOpen = (el: Element) => el.isConnected && el.getAttribute("data-state") !== "closed";

export type BackOutcome = "closed-layer" | "layer-refused" | "history-back" | "background";

export type BackEnv = {
  document: Document;
  pathname: () => string;
  historyBack: () => void;
  background: () => void;
  /** Lets React commit the close before the layer is looked at again. */
  settle: () => Promise<void>;
};

/** What one press of the back button does. Exported so it can be tested
 *  without a device or the plugin. */
export async function handleBackButton(canGoBack: boolean, env: BackEnv): Promise<BackOutcome> {
  const layer = topmostOpenLayer(env.document);
  if (layer) {
    // From the document's own window, so the event belongs to the realm the
    // listeners live in (and so a test can hand in a document of its own).
    const KeyboardEventCtor = env.document.defaultView?.KeyboardEvent ?? KeyboardEvent;
    const esc = new KeyboardEventCtor("keydown", {
      key: "Escape",
      code: "Escape",
      keyCode: 27,
      bubbles: true,
      cancelable: true,
    });
    // At the focused element, as a real key press would be: an input inside
    // a dialog that handles its own Escape (a combobox, cmdk) gets first go.
    const target = env.document.activeElement ?? env.document.body;
    target.dispatchEvent(esc);
    await env.settle();
    if (!stillOpen(layer)) return "closed-layer";
    // Radix calls preventDefault when it dismisses AND when the dialog's own
    // onEscapeKeyDown refuses. Still open with the event claimed is a refusal.
    if (esc.defaultPrevented) return "layer-refused";
    // Nobody listened. Fall through rather than leave back dead.
  }
  if (canGoBack && !isBackRoot(env.pathname())) {
    env.historyBack();
    return "history-back";
  }
  env.background();
  return "background";
}

/**
 * Wire the Android hardware back button to handleBackButton. Returns a
 * cleanup that removes the listener. Web: no-op. iOS has no back button and
 * the plugin never fires the event there.
 */
export async function initBackButton(): Promise<() => void> {
  if (!isNative()) return () => {};
  const { App } = await import("@capacitor/app");
  const env: BackEnv = {
    document,
    pathname: () => window.location.pathname,
    historyBack: () => window.history.back(),
    background: () => void App.minimizeApp(),
    settle: () => new Promise((r) => setTimeout(r, 60)),
  };
  const handle = await App.addListener("backButton", ({ canGoBack }) => {
    void handleBackButton(canGoBack, env);
  });
  return () => {
    void handle.remove();
  };
}

/**
 * Android App Links: a tap on https://app.houndstack.com/<staff page> opens
 * the app (AndroidManifest.xml, verified by /.well-known/assetlinks.json) and
 * arrives here as `appUrlOpen`. Navigate to the same path inside the bundle.
 *
 * Cold start is covered by the same listener: Capacitor's App plugin retains
 * the launch URL event until a listener attaches, so this must not ALSO read
 * getLaunchUrl(), or a cold-start link would navigate twice.
 *
 * Anything that is not one of our https links is ignored, in particular the
 * custom-scheme OAuth hand-back, which src/routes/auth.tsx owns.
 */
export async function initAppLinks(onNavigate: (path: string) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const [{ App }, { appLinkTarget }] = await Promise.all([
    import("@capacitor/app"),
    import("@/lib/android-app-links"),
  ]);
  const handle = await App.addListener("appUrlOpen", ({ url }) => {
    const path = appLinkTarget(url);
    if (path) onNavigate(path);
  });
  return () => {
    void handle.remove();
  };
}

/**
 * Route native push-notification taps to the in-app URL carried in the payload
 * (`data.url` from FCM, top-level `url` surfaced in `data` from APNs — see
 * src/lib/push.server.ts). Same-origin paths only; foreign origins are ignored.
 * Returns a cleanup that removes the listener. Web: no-op (the service worker's
 * notificationclick handler covers web push — public/push-handlers.js).
 */
export async function initPushDeepLinks(onNavigate: (path: string) => void): Promise<() => void> {
  if (!isNative()) return () => {};
  const { PushNotifications } = await import("@capacitor/push-notifications");
  const handle = await PushNotifications.addListener(
    "pushNotificationActionPerformed",
    (action) => {
      const data = (action.notification?.data ?? {}) as Record<string, unknown>;
      const nested = (
        typeof data.data === "object" && data.data !== null ? data.data : {}
      ) as Record<string, unknown>;
      const raw = [data.url, nested.url].find(
        (v): v is string => typeof v === "string" && v.length > 0,
      );
      if (!raw) return;
      try {
        const u = new URL(raw, window.location.origin);
        if (u.origin !== window.location.origin) return;
        onNavigate(u.pathname + u.search + u.hash);
      } catch {
        // Malformed URL in payload — open the app without navigating.
      }
    },
  );
  return () => {
    void handle.remove();
  };
}
