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

## Dev workflow (live-reload against the hosted app)

`capacitor.config.ts` points `server.url` to `https://pal-primer.lovable.app`. The native shell just loads that URL, so any Lovable deploy is instantly available in the app — no rebuild required.

```bash
bunx cap sync
bunx cap open ios      # or: bunx cap open android
# Press ▶ in Xcode / Android Studio
```

## Store-ready build (bundled assets, no live server)

1. Comment out the `server` block in `capacitor.config.ts`.
2. Build the web app and copy assets:
   ```bash
   bun run build
   bunx cap sync
   ```
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

1. iOS: enable Push Notifications capability in Xcode; upload APNs auth key to Firebase or your provider.
2. Android: drop `google-services.json` into `android/app/`.
3. Wire tokens to the existing `push_subscriptions` table via `registerPushNotifications`.

## Permissions to declare

- iOS `Info.plist`: `NSCameraUsageDescription`, `NSPhotoLibraryAddUsageDescription`, `NSLocationWhenInUseUsageDescription`.
- Android `AndroidManifest.xml`: `CAMERA`, `ACCESS_FINE_LOCATION`, `POST_NOTIFICATIONS`.

## Notes

- App ID: `consulting.thenorth.pal` — matches the notify subdomain. Change in `capacitor.config.ts` **before** running `cap add`.
- Deep links to visits (`pal://visit/<id>`) can be added later via `@capacitor/app` `appUrlOpen`.
- Offline queue (IndexedDB) already works inside the WebView with no changes.

## Session status

- ✅ Camera: `Take photo` in **My day** and the **Visit drawer** calls `takePhotoNative()` first, falls back to the web `<input capture>` if the plugin refuses.
- ✅ Haptics: `haptic()` routes to Capacitor `Haptics` on device, `navigator.vibrate` on web.
- ✅ Status bar: dark brand style applied in the authenticated shell.
- ✅ Offline queue: unchanged — IndexedDB works inside the WebView.
- ⏳ Push tokens: `push_subscriptions` schema is web-push (endpoint/p256dh/auth). Wire APNs/FCM by adding a `native_token` + `platform` column and calling `registerPushNotifications()` from the authenticated shell.
- ⏳ GPS start-route: `getCurrentPositionNative()` is ready; hook into the tech "Start" action when route optimization needs a live pin.

