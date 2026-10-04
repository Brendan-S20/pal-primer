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

// A tap opens the ITEM the notification is about: /my-day?date=…&visit=…
// lands on that stop. This used to compare the window's pathname with the
// whole url, query string included, so a link that carried one never
// matched an open window and every tap opened a second copy of the app; and
// a window that did match was only focused, never sent to the stop. Now the
// first open window of this app is focused AND navigated there, and a new
// window is opened only when there is none.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || "/my-day";
  event.waitUntil(
    (async () => {
      let target;
      try {
        target = new URL(raw, self.location.origin);
      } catch (_e) {
        target = new URL("/my-day", self.location.origin);
      }
      // Same origin only, like initPushDeepLinks in src/lib/native.ts.
      if (target.origin !== self.location.origin) target = new URL("/my-day", self.location.origin);
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of clientsList) {
        try {
          if (new URL(c.url).origin !== target.origin) continue;
          const focused = await c.focus();
          if (c.url !== target.href && "navigate" in (focused || c)) {
            await (focused || c).navigate(target.href);
          }
          return;
        } catch (_e) {
          // A window that cannot be focused or navigated: try the next one.
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
