// Runtime helpers that gracefully no-op on web and use Capacitor natively.
import { Capacitor } from '@capacitor/core';

export const isNative = () => Capacitor.isNativePlatform();
export const platform = () => Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

export async function hapticImpact(style: 'light' | 'medium' | 'heavy' = 'light') {
  if (!isNative()) return;
  const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
  const map = { light: ImpactStyle.Light, medium: ImpactStyle.Medium, heavy: ImpactStyle.Heavy };
  await Haptics.impact({ style: map[style] });
}

export async function hapticSuccess() {
  if (!isNative()) return;
  const { Haptics, NotificationType } = await import('@capacitor/haptics');
  await Haptics.notification({ type: NotificationType.Success });
}

export async function takePhotoNative(): Promise<Blob | null> {
  if (!isNative()) return null;
  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');
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
  | { ok: false; reason: 'denied' | 'unavailable' | 'timeout' };

export async function getPositionNative(): Promise<NativePosition | null> {
  if (!isNative()) return null;
  const { Geolocation } = await import('@capacitor/geolocation');

  let status = await Geolocation.checkPermissions();
  if (status.location === 'prompt' || status.location === 'prompt-with-rationale') {
    // Only ask when the OS says asking is still possible. Calling
    // requestPermissions() after a denial is a no-op that returns 'denied'
    // again, and on iOS the system prompt never reappears — the way back is
    // Settings, which is what the caller's message says.
    status = await Geolocation.requestPermissions({ permissions: ['location'] });
  }
  if (status.location !== 'granted') return { ok: false, reason: 'denied' };

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
    return { ok: false, reason: /time.?out/i.test(msg) ? 'timeout' : 'unavailable' };
  }
}

export async function registerPushNotifications(onToken: (token: string) => void) {
  if (!isNative()) return;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive !== 'granted') return;
  await PushNotifications.register();
  PushNotifications.addListener('registration', (t) => onToken(t.value));
}

export async function initStatusBar() {
  if (!isNative()) return;
  const { StatusBar, Style } = await import('@capacitor/status-bar');
  // Match the rendered app theme, not the (dark) splash. The staff app ships
  // light-themed — dark mode is opt-in via a `.dark` root class — so pick the
  // icon style from the actual document state: Style.Light = dark icons for a
  // light background; Style.Dark = light icons for a dark background.
  const dark =
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
  if (platform() === 'android') {
    try {
      await StatusBar.setBackgroundColor({ color: dark ? '#0F172A' : '#FFFFFF' });
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
  const { App } = await import('@capacitor/app');
  const handle = await App.addListener('backButton', ({ canGoBack }) => {
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
export async function initPushDeepLinks(
  onNavigate: (path: string) => void,
): Promise<() => void> {
  if (!isNative()) return () => {};
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const handle = await PushNotifications.addListener(
    'pushNotificationActionPerformed',
    (action) => {
      const data = (action.notification?.data ?? {}) as Record<string, unknown>;
      const nested = (typeof data.data === 'object' && data.data !== null ? data.data : {}) as Record<string, unknown>;
      const raw = [data.url, nested.url].find(
        (v): v is string => typeof v === 'string' && v.length > 0,
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
