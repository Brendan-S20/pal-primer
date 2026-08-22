import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // appId is the store identity (APNS_TOPIC matches it) — changing it is an
  // owner decision, not a rename.
  appId: "consulting.thenorth.pal",
  // Display name — kept in sync with the PWA manifest (vite.config.ts) and the
  // head <title> (src/routes/__root.tsx).
  appName: "HoundStack",
  // Output of `npm run build:native`, NOT of `npm run build`.
  //
  // `npm run build` is the hosted web build: Nitro packages it for deployment
  // into `.output/{server,public}`, and `.output/public` contains static assets
  // and NO index.html — nothing a WebView can boot. `build:native` skips the
  // deploy packaging, turns on TanStack Start's SPA prerender and emits a real
  // client-bootable shell here at dist-native/client/index.html, alongside the
  // hashed assets it references. That is what ships inside the binary.
  webDir: "dist-native/client",
  server: {
    // NO `url` BY DEFAULT — the app loads the bundled `webDir` above.
    //
    // This was hard-coded to https://pal-primer.lovable.app — a Lovable PREVIEW
    // domain — with a comment saying to remove it before a store build. Nothing
    // enforced that, so a binary built today would have shipped pointing at a
    // preview host rather than the product: wrong domain, and a dependency on
    // an environment nobody promises to keep alive. It also meant the app could
    // not start at all without network.
    //
    // Setting `url` makes the WebView load a remote origin and ignore the
    // bundle entirely, so it is now opt-in for dev live-reload only:
    // CAP_SERVER_URL=http://192.168.1.10:8080 npx cap run ios
    //
    // cleartext is derived from that URL rather than hard-coded: a LAN dev
    // server is http://, and permitting cleartext unconditionally would relax
    // the ATS/network-security policy of the shipped binary too.
    ...(process.env.CAP_SERVER_URL
      ? {
          url: process.env.CAP_SERVER_URL,
          cleartext: process.env.CAP_SERVER_URL.startsWith("http://"),
        }
      : {}),
  },
  ios: {
    // "never", not "always", and the difference is 62pt of dead space at the
    // top of every screen.
    //
    // This is WKWebView's SCROLL VIEW inset, and "always" applies the safe area
    // to the document itself — the accessibility tree put <body> at y=62 on a
    // WebView measured at {{0,0},{402,874}}. Three things follow from that, all
    // of them wrong, and none visible without measuring:
    //
    //   * env(safe-area-inset-top) still resolves to 62 inside that inset
    //     document, so the header's own padding is a SECOND inset. The bar sat
    //     62pt below the status bar with 62pt of white above it.
    //   * `position: fixed; inset: 0` resolves to the inset viewport, so it
    //     cannot reach the top of the screen. The guided tour's dim overlay
    //     stopped dead at 62pt and left a bright white strip across the top.
    //   * The header is designed to extend UNDER the status bar and paint its
    //     own background there (see nativeTopBarStyle in src/lib/native-build.ts).
    //     It never could, because the document it lives in started below it.
    //
    // With "never" the document starts at 0 and the safe area is handled where
    // this codebase already handles it: in CSS, via env(), which is what
    // viewport-fit=cover in src/routes/__root.tsx exists to make resolve.
    contentInset: "never",
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      // A BACKSTOP, not the mechanism. src/routes/__root.tsx calls
      // SplashScreen.hide() once the app has painted, which is the only signal
      // that actually means "ready"; this number only decides how long a build
      // that never gets there is allowed to sit on the splash.
      //
      // It was 1500, and it was doing the hiding. iOS QA 2026-08-20 measured
      // the consequence on a cold launch: cream splash from 5.4s to 7.3s, then
      // a BLANK WHITE screen from 7.4s to 12.7s, then the app. The timer had no
      // way to know the bundle had not rendered yet, so it lifted the splash on
      // schedule and revealed nothing. Capacitor logged the advice on every
      // launch; this is taking it.
      launchShowDuration: 20000,
      launchAutoHide: true,
      // Cream, matching the PWA manifest's background_color in vite.config.ts.
      //
      // This was #0F172A, a dark slate that appears nowhere else in the
      // product: the installed web app opens on cream, the app itself is
      // light-themed, and owner QA item 12 expects "HoundStack icon + cream
      // splash". A native binary would have been the only surface that opened
      // dark and then flipped to cream a second and a half later.
      backgroundColor: "#fdfaf1",
      showSpinner: false,
    },
    StatusBar: {
      // Launch-time style only. Once the WebView boots, src/lib/native.ts
      // initStatusBar() re-asserts the style from the rendered app theme.
      //
      // 'LIGHT' means DARK ICONS on a light background (Capacitor names the
      // style after the content, not the surface). That is correct for the
      // cream splash below, and it is what the booted app asks for too, so
      // there is no flash of white-on-cream at launch.
      style: "LIGHT",
      backgroundColor: "#fdfaf1",
    },
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
