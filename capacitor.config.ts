import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // appId is the store identity (APNS_TOPIC matches it) — changing it is an
  // owner decision, not a rename.
  appId: 'consulting.thenorth.pal',
  // Display name — kept in sync with the PWA manifest (vite.config.ts) and the
  // head <title> (src/routes/__root.tsx).
  appName: 'HoundStack',
  // NOTE: this app is server-rendered (TanStack Start + Nitro), so
  // `.output/public` holds static assets and NO index.html — there is nothing
  // here for a WebView to boot. `webDir` is required by the CLI but is not, on
  // its own, a runnable bundle. See the note on `server.url` below; Q-3's
  // answer ("bundled Capacitor assets") is an architecture change, not a config
  // flag, and is not done.
  webDir: '.output/public',
  server: {
    // WHICH SERVER THE SHIPPED APP LOADS.
    //
    // This was hard-coded to https://pal-primer.lovable.app — a Lovable PREVIEW
    // domain — with a comment saying to remove it before a store build. Nothing
    // enforced that, so a binary built today would have shipped pointing at a
    // preview host rather than the product: wrong domain, and a dependency on
    // an environment nobody promises to keep alive.
    //
    // Defaults to production now, and dev live-reload is opt-in through
    // CAP_SERVER_URL, so the dangerous value can no longer be the one you get
    // by forgetting. Set CAP_SERVER_URL=https://pal-primer.lovable.app while
    // developing against the preview.
    url: process.env.CAP_SERVER_URL || 'https://app.houndstack.com',
    cleartext: false,
  },
  ios: {
    contentInset: 'always',
    limitsNavigationsToAppBoundDomains: false,
  },
  android: {
    allowMixedContent: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      backgroundColor: '#0F172A',
      showSpinner: false,
    },
    StatusBar: {
      // Launch-time style only — matches the dark splash. Once the WebView
      // boots, src/lib/native.ts initStatusBar() re-asserts the style to match
      // the rendered app theme (light app → dark icons).
      style: 'DARK',
      backgroundColor: '#0F172A',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
