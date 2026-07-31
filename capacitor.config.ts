import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // appId is the store identity (APNS_TOPIC matches it) — changing it is an
  // owner decision, not a rename.
  appId: 'consulting.thenorth.pal',
  // Display name — kept in sync with the PWA manifest (vite.config.ts) and the
  // head <title> (src/routes/__root.tsx).
  appName: 'HoundStack',
  // Output of `npm run build:native`, NOT of `npm run build`.
  //
  // `npm run build` is the hosted web build: Nitro packages it for deployment
  // into `.output/{server,public}`, and `.output/public` contains static assets
  // and NO index.html — nothing a WebView can boot. `build:native` skips the
  // deploy packaging, turns on TanStack Start's SPA prerender and emits a real
  // client-bootable shell here at dist-native/client/index.html, alongside the
  // hashed assets it references. That is what ships inside the binary.
  webDir: 'dist-native/client',
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
          cleartext: process.env.CAP_SERVER_URL.startsWith('http://'),
        }
      : {}),
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
