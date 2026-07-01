// Guarded service-worker registration wrapper. This is the only place the app
// touches the service worker — never register elsewhere. See PWA skill.
//
// Registration is refused in dev, iframes, Lovable preview hosts, and when
// the URL includes ?sw=off. In any refused context, an already-registered
// /sw.js is unregistered so no stale worker keeps serving old HTML.

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
