/* eslint-disable no-restricted-globals */
// Web Push handlers injected into the workbox service worker via
// vite-plugin-pwa `workbox.importScripts`.

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (_e) {
    payload = { title: "HoundStack", body: event.data ? event.data.text() : "" };
  }
  const title = payload.title || "HoundStack";
  const options = {
    body: payload.body || "",
    icon: payload.icon || "/pwa-192.png",
    badge: payload.badge || "/pwa-192.png",
    tag: payload.tag || undefined,
    renotify: !!payload.tag,
    data: { url: payload.url || "/my-day", ...(payload.data || {}) },
    requireInteraction: !!payload.requireInteraction,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/my-day";
  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clientsList) {
        try {
          const u = new URL(c.url);
          if (u.pathname === url || u.pathname.startsWith(url)) {
            await c.focus();
            return;
          }
        } catch (_e) {
          // ignore
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
