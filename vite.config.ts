// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import path from "node:path";
import { loadEnv } from "vite";
import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { VitePWA } from "vite-plugin-pwa";

// Populate process.env with all env vars (not just VITE_) so server routes
// can read SUPABASE_SERVICE_ROLE_KEY, LOVABLE_API_KEY, etc.
const serverEnv = loadEnv(process.env.NODE_ENV || "development", process.cwd(), "");
Object.assign(process.env, serverEnv);

// BUILD-9. The native app has to boot with no network, and this app is
// server-rendered: `.output/public` held static assets and NO index.html, so
// there was literally nothing for a WebView to load. That is why
// capacitor.config.ts pointed at a remote URL, and why the store app had no
// offline capability at all whatever the marketing site claimed.
//
// SPA mode prerenders a client-bootable shell to /index.html. It is gated on
// NATIVE_BUILD rather than switched on globally BECAUSE IT CHANGES RENDERING
// MODE: turning it on for the hosted app at app.houndstack.com would trade its
// server-rendered first paint for a client-side boot, which is a decision about
// the web product and not something to change as a side effect of fixing the
// native one. `npm run build:native` sets it; `npm run build` is untouched.
const NATIVE_BUILD = process.env.NATIVE_BUILD === "1";

// Where a bundled build sends server functions. Server-function URLs are baked
// into the client bundle at build time as a PATH (`/_serverFn/<id>`), which is
// correct only while the document is served from the API's own origin. In a
// Capacitor bundle the origin is capacitor://localhost / https://localhost, so
// that path resolves to the app bundle — which serves no API — and every
// server function fails even on a perfect network. `serverFns.base` cannot fix
// it (TanStack's createServerFnBasePath runs the value through joinPaths, which
// collapses `//`, so an absolute URL becomes "/https:/app.houndstack.com/..."),
// so the origin is handed to the runtime instead — see src/lib/server-fn-origin.ts.
// Override with NATIVE_API_ORIGIN=... to build a binary against staging.
const NATIVE_API_ORIGIN = NATIVE_BUILD
  ? process.env.NATIVE_API_ORIGIN || "https://app.houndstack.com"
  : "";

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
    ...(NATIVE_BUILD
      ? {
          spa: {
            enabled: true,
            // The shell is prerendered by requesting this path with the
            // TSS_SHELL header. It defaulted to "/", which is the one route in
            // this app whose beforeLoad throws a redirect (routes/index.tsx
            // sends everyone to /auth), so the shell's <head> was generated
            // from a render that never produced a page: index.html shipped the
            // root's generic title while the first screen is always /auth.
            //
            // WHAT THIS DOES NOT FIX, so nobody re-runs the investigation: the
            // React #418 hydration error on every cold launch is NOT this.
            // Changing the mask path leaves the prerendered <body> byte-for-byte
            // identical — TSS_SHELL renders the shell only, so the outlet is an
            // empty RESOLVED Suspense boundary (`<!--$--><!--/$-->`, not a
            // pending `<!--$?-->`) whichever path is used, and the client then
            // hydrates a real route into it. Measured, not assumed: removing
            // <Toaster> did not change it either, and it reproduces in desktop
            // Chromium against dist-native/client, so it is neither ours nor
            // iOS-specific. See docs/ios-qa-results.md.
            maskPath: "/auth",
            prerender: { enabled: true, outputPath: "/index.html" },
          },
        }
      : {}),
  },
  // The prerender that produces index.html works by booting a Vite *preview*
  // server against the just-built server bundle, and it looks for it at the
  // stock TanStack layout `<build.outDir>/server/server.js`. The web build has
  // no such file: the Lovable wrapper runs Nitro with the cloudflare-module
  // preset, which relocates the output to `.output/{server,public}` — hence
  // `Cannot find module '<root>/dist/server/server.js'` the moment SPA
  // prerendering is switched on. Nitro also only registers during `command ===
  // "build"`, so its own preview handler is absent when the prerenderer
  // re-resolves this config in preview mode; there is nothing to fall back to.
  //
  // The native build does not deploy a server at all — it needs static files in
  // an app bundle — so the deploy packaging is simply skipped and Vite's stock
  // layout is kept. `dist-native/` keeps it clear of the web build's `.output/`
  // so the two can coexist without either clobbering the other.
  ...(NATIVE_BUILD ? { nitro: false as const } : {}),
  vite: {
    ...(NATIVE_BUILD ? { build: { outDir: "dist-native" } } : {}),
    // The SPA prerender boots a Vite PREVIEW server, and Vite's default host
    // binds the IPv6 wildcard `::`. On a host without IPv6 that throws
    // `EAFNOSUPPORT: address family not supported ::` and the whole native
    // build dies AFTER a clean client bundle, so the failure reads like a
    // build error rather than a networking one. Pinning the preview host to
    // IPv4 loopback costs the hosted build nothing (it never prerenders) and
    // makes `build:native` work on Linux CI and in containers as well as on a
    // Mac. Not `localhost`: that resolves to ::1 first on many systems, which
    // is the same trap wearing a friendlier name.
    ...(NATIVE_BUILD ? { preview: { host: "127.0.0.1" } } : {}),
    // Native-only rather than defined-as-"" for both, so this whole config is
    // provably inert for the hosted build: with only vite.config.ts changed,
    // `npm run build` reproduces .output byte-for-byte apart from the two files
    // that already differ between two consecutive identical builds (nitro.json
    // and server/index.mjs, which embed the build timestamp). Without the
    // define the key is simply absent from import.meta.env, so
    // src/lib/server-fn-origin.ts reads "" and the branch in src/start.ts is
    // dropped from the web bundle entirely.
    ...(NATIVE_BUILD
      ? {
          define: {
            "import.meta.env.VITE_NATIVE_API_ORIGIN": JSON.stringify(NATIVE_API_ORIGIN),
            // "This bundle is the one inside the app binary."
            //
            // A SEPARATE key from the origin above, deliberately. The origin
            // answers "where do server functions go"; this answers "may I
            // change how the product looks and behaves". Overloading one on the
            // other would mean a future staging origin silently switching UI
            // branches on, which is exactly the class of accident this flag
            // exists to prevent.
            //
            // Native-only, like its neighbour, so the key is simply ABSENT from
            // import.meta.env in the hosted build and every branch that reads
            // src/lib/native-build.ts folds away. `main` deploys straight to
            // app.houndstack.com, so an iOS fix that reaches `src/` is live on
            // the web the moment it merges — see docs/ios-qa-results.md.
            "import.meta.env.VITE_NATIVE_BUNDLE": JSON.stringify("1"),
          },
        }
      : {}),
    resolve: {
      alias: {
        "entities/lib/decode.js": path.resolve(
          import.meta.dirname,
          "node_modules/entities/lib/decode.js",
        ),
        "entities/lib/encode.js": path.resolve(
          import.meta.dirname,
          "node_modules/entities/lib/encode.js",
        ),
        entities: path.resolve(import.meta.dirname, "node_modules/entities"),
      },
    },
    plugins: [
      VitePWA({
        // WHERE THE WORKER ACTUALLY GOES.
        //
        // It was being written to Vite's default outDir — `dist/` — while the
        // deployed client assets are produced by Nitro into `.output/public`.
        // So /sw.js has never existed on the web: src/pwa/register.ts asked the
        // browser for it and got a 404, and every runtime-caching rule below
        // has been dead since it was written.
        //
        // Setting outDir also fixes the second half. workbox globs this same
        // directory to build its precache manifest, and `dist/` contained no
        // app assets, so even the orphaned worker precached NOTHING — a file
        // that was both undeployed and empty.
        //
        // Skipped entirely for the native build, which serves its own bundled
        // shell: precaching would duplicate files already on disk and
        // navigateFallback could shadow the shipped shell with a stale one.
        // See src/pwa/register.ts, which refuses to register there.
        outDir: NATIVE_BUILD ? "dist-native/client" : ".output/public",
        registerType: "autoUpdate",
        injectRegister: null,
        filename: "sw.js",
        devOptions: { enabled: false },
        // Only reference assets that actually exist in public/ — a missing
        // apple-touch-icon.png/favicon.ico would 404 from the precache.
        includeAssets: ["favicon.svg", "favicon.ico", "apple-touch-icon.png"],
        manifest: {
          // Keep in sync with the head <title> (src/routes/__root.tsx) and
          // capacitor.config.ts appName.
          name: "HoundStack",
          short_name: "HoundStack",
          description: "Field service CRM for pet waste removal companies",
          // Brand cream (--cream oklch(0.985 0.012 90)) — matches the icon
          // backgrounds and the marketing hero, not the old slate navy.
          theme_color: "#fdfaf1",
          background_color: "#fdfaf1",
          display: "standalone",
          // "/" and not "/my-day". /my-day is the technician's screen: an
          // owner or office manager who installed the app landed every time on
          // a route their role has no visits on. "/" redirects to /auth, which
          // when a session already exists runs `landingPathForUser` and sends
          // each role to its own home — the same path the app uses after
          // sign-in, so the installed app opens where the browser would.
          start_url: "/",
          scope: "/",
          icons: [
            { src: "/pwa-192.png", sizes: "192x192", type: "image/png" },
            { src: "/pwa-512.png", sizes: "512x512", type: "image/png" },
            {
              src: "/pwa-512-maskable.png",
              sizes: "512x512",
              type: "image/png",
              purpose: "maskable",
            },
          ],
        },
        workbox: {
          importScripts: ["/push-handlers.js"],
          // EXPLICITLY undefined, not merely absent. vite-plugin-pwa defaults
          // this to "index.html" (its dist/index.js, the workbox defaults
          // object), so deleting the line does not remove the NavigationRoute —
          // it only swaps which non-existent URL is passed to
          // createHandlerBoundToURL. Verified by rebuilding and reading the
          // emitted worker: the call came back as
          // `createHandlerBoundToURL("index.html")`.
          navigateFallback: undefined,
          // Disabling it is load-bearing rather than an omission. It was `"/"`,
          // and that ONE LINE disabled the entire
          // offline story — the fourth reason in a row, after the three
          // recorded further down this file.
          //
          // This is an SSR app: Nitro renders HTML per request and the web
          // build emits no index.html at all, so nothing named "/" is ever in
          // the precache manifest (it holds icons and the webmanifest, nothing
          // else). `createHandlerBoundToURL("/")` THROWS when its argument is
          // not precached, and the generated worker is a single top-level comma
          // sequence:
          //
          //   precacheAndRoute(...), cleanupOutdatedCaches(),
          //   registerRoute(new NavigationRoute(createHandlerBoundToURL("/"))),
          //   registerRoute(navigate -> NetworkFirst),
          //   registerRoute(/assets/ -> CacheFirst)
          //
          // so the throw took out BOTH runtime rules below it. Navigations went
          // unhandled and no asset was ever runtime-cached: a tech cold-opening
          // the installed PWA in a yard with no signal got the browser's
          // no-internet page, not the app.
          //
          // The NetworkFirst rule immediately below is the correct mechanism
          // for an SSR app anyway — it caches each navigation as it happens and
          // serves it back when the network is gone, which is what a fallback
          // shell would only have approximated.
          runtimeCaching: [
            {
              // App shell / HTML — network first, fall back to cache when offline.
              //
              // Carries the exclusions that used to live in
              // navigateFallbackDenylist. These are all real navigations (an
              // unsubscribe link, an OAuth bounce), so `request.mode` alone does
              // not exclude them, and serving a cached shell in their place
              // would break the flow.
              urlPattern: ({ request, url }) =>
                request.mode === "navigate" &&
                !/^\/(api|lovable|email|~oauth)\//.test(url.pathname),
              handler: "NetworkFirst",
              options: {
                cacheName: "app-shell",
                networkTimeoutSeconds: 3,
                expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 7 },
              },
            },
            {
              // Hashed built assets — safe to cache-first.
              //
              // This tested for `/_build/`, which this build has never
              // produced: Nitro emits hashed assets under `/assets/`. So the
              // rule matched nothing and no asset was ever runtime-cached —
              // the third of three reasons the offline story on web was
              // decorative (the other two: the worker was written to an
              // undeployed directory, and its precache manifest was empty).
              urlPattern: ({ url, sameOrigin }) => sameOrigin && /\/assets\//.test(url.pathname),
              handler: "CacheFirst",
              options: {
                cacheName: "static-assets",
                expiration: { maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 30 },
              },
            },
          ],
        },
      }),
    ],
  },
});
