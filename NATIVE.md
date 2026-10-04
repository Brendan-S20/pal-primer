# Native iOS / Android build (Capacitor)

Pal ships as a PWA and as native iOS/Android shells via Capacitor. The web app is the single source of truth — the native shells load the same UI.

## One-time local setup

Requires Node 20+, Xcode 15+ (macOS) for iOS, and Android Studio Hedgehog+ for Android.

```bash
git clone <repo>
cd <repo>
bun install
bunx cap add ios
bunx cap add android
```

## Dev workflow (live-reload against a dev server)

`capacitor.config.ts` sets **no** `server.url` by default — the shell loads the
bundled assets in `webDir`. It used to hard-code
`https://pal-primer.lovable.app`, a preview domain, with a comment saying to
remove it before a store build; nothing enforced that, so a binary built on any
given day could ship pointing at a preview host. Live reload is opt-in through
an environment variable instead, and the flag that permits cleartext is derived
from the URL rather than left on:

```bash
CAP_SERVER_URL=http://192.168.1.10:8080 bunx cap sync
bunx cap open ios      # or: bunx cap open android
# Press ▶ in Xcode / Android Studio
```

Leave `CAP_SERVER_URL` unset and the app runs entirely from the bundle, offline
included.

## Store-ready build (bundled assets, no live server)

1. Nothing to comment out — with `CAP_SERVER_URL` unset there is no `server.url`.
2. Build the web app and copy assets:
   ```bash
   bun run build:native   # NOT `bun run build`
   bunx cap sync
   ```
   `build:native` is the one that produces a bootable shell. `bun run build` is
   the hosted web build: Nitro packages it into `.output/{server,public}` and
   `.output/public` contains assets and **no index.html**, so a WebView pointed
   at it has nothing to load. `webDir` is `dist-native/client`, which only
   `build:native` writes — see the comment on `webDir` in `capacitor.config.ts`.
3. Open the native project and archive:
   ```bash
   bunx cap open ios      # Product → Archive → App Store Connect
   bunx cap open android  # Build → Generate Signed Bundle → AAB → Play Console
   ```

## Native APIs available in code

Import from `@/lib/native` — every helper no-ops on web, uses the plugin natively:

- `hapticImpact('light' | 'medium' | 'heavy')` — button feedback
- `hapticSuccess()` — completion cue
- `takePhotoNative()` — native camera → `Blob`, falls back to `null` on web (use the existing file input)
- `getCurrentPositionNative()` — high-accuracy GPS for tech "start route"
- `registerPushNotifications(onToken)` — APNs / FCM registration
- `initStatusBar()` — dark status bar to match brand

## Push notifications

1. iOS: done in the repo (entitlement + AppDelegate forwards); the server sends to APNs directly with the `.p8` key — no Firebase. See `docs/ios-build.md` › Push notifications.
2. Android: drop `google-services.json` into `android/app/`.
3. Wire tokens to the existing `push_subscriptions` table via `registerPushNotifications`.

## Permissions to declare

- iOS `Info.plist`: `NSCameraUsageDescription`, `NSPhotoLibraryAddUsageDescription`, `NSLocationWhenInUseUsageDescription`.
- Android `AndroidManifest.xml`: `CAMERA`, `ACCESS_FINE_LOCATION`, `POST_NOTIFICATIONS`.

## Notes

- App ID: `consulting.thenorth.houndstack` — matches the notify subdomain. Change in `capacitor.config.ts` **before** running `cap add`.
- Deep links to visits (`pal://visit/<id>`) can be added later via `@capacitor/app` `appUrlOpen`.
- Offline queue (IndexedDB) already works inside the WebView with no changes.

## Session status

- ✅ Camera: `Take photo` in **My day** and the **Visit drawer** calls `takePhotoNative()` first, falls back to the web `<input capture>` if the plugin refuses.
- ✅ Haptics: `haptic()` routes to Capacitor `Haptics` on device, `navigator.vibrate` on web.
- ✅ Status bar: dark brand style applied in the authenticated shell.
- ✅ Offline queue: unchanged — IndexedDB works inside the WebView.
- ✅ Push tokens: `push_subscriptions` carries `native_token` + `platform` alongside the web-push columns, and `src/lib/push.server.ts` fans out to Web Push, APNs and FCM from one call. Android uses **FCM HTTP v1** with a service-account JWT (`FCM_SERVICE_ACCOUNT`); the legacy `fcm.googleapis.com/fcm/send` server-key API it used before was decommissioned by Google. Each channel is skipped silently when its credentials are absent, so an unconfigured one never takes the others down.
- ⏳ GPS start-route: `getCurrentPositionNative()` is ready; hook into the tech "Start" action when route optimization needs a live pin.

