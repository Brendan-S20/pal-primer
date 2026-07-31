// Guarded service-worker registration wrapper. This is the only place the app
// touches the service worker — never register elsewhere. See PWA skill.
//
// Registration is refused in dev, iframes, Lovable preview hosts, inside the
// native app bundle, and when the URL includes ?sw=off. In any refused context,
// an already-registered /sw.js is unregistered so no stale worker keeps serving
// old HTML.

import { isNative } from "@/lib/native";

const APP_SW_PATH = "/sw.js";

function isPreviewHost(hostname: string): boolean {
  return (
    hostname.startsWith("id-preview--") ||
    hostname.startsWith("preview--") ||
    hostname === "lovableproject.com" ||
    hostname.endsWith(".lovableproject.com") ||
    hostname === "lovableproject-dev.com" ||
    hostname.endsWith(".lovableproject-dev.com") ||
    hostname === "beta.lovable.dev" ||
    hostname.endsWith(".beta.lovable.dev")
  );
}

function shouldRefuse(): boolean {
  if (typeof window === "undefined") return true;
  if (!import.meta.env.PROD) return true;
  if (window.self !== window.top) return true;
  if (isPreviewHost(window.location.hostname)) return true;
  // BUILD-9: the worker exists to make a REMOTELY served app installable and
  // offline-tolerant. `npm run build:native` bundles the shell and every hashed
  // asset into the binary, so the two things this worker does are already done
  // — precaching duplicates files that are on disk, and NetworkFirst on
  // navigations would put a 3s network timeout in front of a document that is
  // local. Worse, `navigateFallback: "/"` means a stale cached shell could
  // shadow the one shipped in the update. Web push, the other reason to have a
  // worker, is handled natively by @capacitor/push-notifications (see
  // src/lib/native.ts), not by public/push-handlers.js. Note the native build
  // does not even emit /sw.js, so registering here would only 404.
  if (isNative()) return true;
  if (new URL(window.location.href).searchParams.get("sw") === "off") return true;
  return false;
}

async function unregisterApp() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  try {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const reg of regs) {
      const url =
        reg.active?.scriptURL || reg.waiting?.scriptURL || reg.installing?.scriptURL || "";
      if (url.endsWith(APP_SW_PATH)) {
        await reg.unregister();
      }
    }
  } catch {
    /* ignore */
  }
}

export async function registerPwa() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  if (shouldRefuse()) {
    await unregisterApp();
    return;
  }
  try {
    // Dynamic import so workbox-window is only loaded in prod on real hosts.
    const { Workbox } = await import("workbox-window");
    const wb = new Workbox(APP_SW_PATH);
    wb.addEventListener("waiting", () => {
      // On next visit the new worker will take control automatically.
      wb.messageSkipWaiting();
    });
    await wb.register();
  } catch (e) {
    console.warn("PWA registration failed", e);
  }
}
