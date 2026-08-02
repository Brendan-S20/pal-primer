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
          start_url: "/my-day",
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
          navigateFallback: "/",
          navigateFallbackDenylist: [/^\/api\//, /^\/lovable\//, /^\/email\//, /^\/~oauth/],
          runtimeCaching: [
            {
              // App shell / HTML — network first, fall back to cache when offline
              urlPattern: ({ request }) => request.mode === "navigate",
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
