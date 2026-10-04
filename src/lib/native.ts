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

/** The APNs/FCM token this device registered in THIS session, so sign-out can
 *  release it. Memory only: registration runs on every launch of the signed-in
 *  shell, so a session that has a token to release always set this first. */
let registeredPushToken: string | null = null;

/**
 * Ask for notification permission and register this device for push.
 *
 * WHEN: called from the signed-in shell (src/routes/_authenticated/route.tsx),
 * never from the root — so the system prompt appears after sign-in, when the
 * token has a user to belong to, and never on the sign-in screen of a fresh
 * install. After the first answer iOS never shows the prompt again; later
 * launches only re-register, which is how a rotated token reaches the server.
 *
 * TOKEN REFRESH: APNs can hand out a new token (restore from backup, reinstall,
 * OS update). `register()` runs on every launch and the `registration` event
 * delivers whatever the token is NOW, so a changed one is saved within one
 * launch; the stale row is switched off by the server the first time APNs
 * answers 410 for it.
 *
 * Returns a cleanup that removes the listeners.
 */
export async function registerPushNotifications(
  onToken: (token: string) => void,
): Promise<() => void> {
  if (!isNative()) return () => {};

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
  if (platform() === "android" && !FCM_CONFIGURED) {
    console.warn(
      "[push] android/app/google-services.json is absent, so FCM cannot initialise. " +
        "Skipping push registration: calling it would crash the app, not fail softly.",
    );
    return () => {};
  }

  const { PushNotifications } = await import("@capacitor/push-notifications");
  // Check first and only ASK while asking is still possible. After a denial
  // requestPermissions() is a silent no-op on iOS; the way back is Settings.
  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== "granted") return () => {};

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
    // entitlement (see docs/ios-build.md › Push notifications).
    console.warn("[push] registration failed", e.error);
  });
  await PushNotifications.register();
  return () => {
    void onRegistration.remove();
    void onError.remove();
  };
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

/**
 * Android hardware back button: pop in-app history when there is somewhere to
 * go back to, minimize the app at the navigation root (never exit-blast the
 * WebView). Returns a cleanup that removes the listener. Web: no-op.
 */
export async function initBackButton(): Promise<() => void> {
  if (!isNative()) return () => {};
  const { App } = await import("@capacitor/app");
  const handle = await App.addListener("backButton", ({ canGoBack }) => {
    if (canGoBack && window.history.length > 1) {
      window.history.back();
    } else {
      void App.minimizeApp();
    }
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
