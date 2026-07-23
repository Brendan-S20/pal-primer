import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // appId is the store identity (APNS_TOPIC matches it) — changing it is an
  // owner decision, not a rename.
  appId: 'consulting.thenorth.pal',
  // Display name — kept in sync with the PWA manifest (vite.config.ts) and the
  // head <title> (src/routes/__root.tsx).
  appName: 'HoundStack',
  webDir: '.output/public',
  server: {
    // Point to your Lovable published URL for live-reload during dev.
    // Comment out `url` before building a store-ready binary that runs from bundled assets.
    url: 'https://pal-primer.lovable.app',
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
