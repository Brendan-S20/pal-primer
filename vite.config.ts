// @lovable.dev/vite-tanstack-config already includes the following — do NOT add them manually
// or the app will break with duplicate plugins:
//   - tanstackStart, viteReact, tailwindcss, tsConfigPaths, nitro (build-only using cloudflare as a default target),
//     componentTagger (dev-only), VITE_* env injection, @ path alias, React/TanStack dedupe,
//     error logger plugins, and sandbox detection (port/host/strictPort).
// You can pass additional config via defineConfig({ vite: { ... }, etc... }) if needed.
import path from "node:path";
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
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

// ── DOES THIS BINARY HAVE A FIREBASE CONFIG? ──────────────────────────────
//
// Without `android/app/google-services.json`, Capacitor's push plugin calls
// FirebaseMessaging.getInstance() and Firebase throws
// "Default FirebaseApp is not initialized in this process". That exception is
// raised on the native CapacitorPlugins thread, so `await
// PushNotifications.register()` in TypeScript NEVER REJECTS -- it is uncaught,
// and the process dies. No try/catch in src/ can prevent it.
//
// Measured on an emulator 2026-09-15: grant the notification permission and the
// app is killed on launch, deterministically. Deny it and the app is fine,
// because registerPushNotifications returns early. So the crash lands on
// exactly the users who say yes, which is why nothing caught it.
//
// This flag is the honest signal, and it maintains itself: drop the real
// google-services.json into android/app/ and push registration switches back on
// at the next build with no code change. It does NOT gate iOS, which reaches
// APNs through Capacitor without Firebase.
const FCM_CONFIGURED =
  NATIVE_BUILD && existsSync(path.resolve(process.cwd(), "android/app/google-services.json"));

// ── WHERE THE CLIENT BUILD ACTUALLY WRITES, WHICH IS NOT ONE PLACE ───────
//
// /sw.js answered 404 in production for about three weeks, and the reason was
// two directories rather than anything to do with the worker.
//
// @lovable.dev/vite-tanstack-config branches on whether it is running inside
// the hosted build environment, and in that branch it overrides Nitro's output
// paths (its dist/index.js, in the `if (isSandbox)` block):
//
//     nitroOpts.output = { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" }
//
// Outside it, Nitro's cloudflare-module defaults give `.output/public`. So the
// deployed client directory is `dist/client` on the host and `.output/public`
// on a laptop, and this file used to hardcode the second one. Everything that
// goes through Rollup or Nitro's own public/ copy follows Nitro and shipped;
// the two files vite-plugin-pwa writes DIRECTLY TO DISK in closeBundle follow
// this option, so they landed in a directory the hosted build never produced.
//
// Reproduced locally with `LOVABLE_SANDBOX=1 npx vite build`:
//
//     dist/client/      assets, manifest.webmanifest, favicon.ico, ...  (no sw.js)
//     .output/public/   sw.js, workbox-<hash>.js                        (nothing else)
//
// WHY NOT SIMPLY DROP THIS OPTION AND LET THE PLUGIN DEFAULT. Because its
// default is `viteConfig.build.outDir`, the TOP-LEVEL one, which is Vite's
// plain "dist". Nitro sets the real value in `configEnvironment` on the CLIENT
// environment's config (nitro/dist/vite.mjs: `config.build.outDir =
// useNitro(ctx).options.output.publicDir`), and the plugin never reads that.
// Dropping the option reinstates the original fault, which is exactly how the
// worker came to be written to `dist/` before #104.
//
// A copy after the fact does not work either: workbox globs this directory to
// build the precache manifest, so a worker generated against the wrong
// directory ships with a manifest of whatever happened to be in it.
const HOSTED_BUILD = process.env.LOVABLE_SANDBOX === "1" || !!process.env.DEV_SERVER__PROJECT_PATH;

const PWA_OUT_DIR = NATIVE_BUILD
  ? "dist-native/client"
  : HOSTED_BUILD
    ? "dist/client"
    : ".output/public";

// THE LINE ABOVE IS A THIRD COPY OF SOMEBODY ELSE'S PRIVATE CONTRACT, and this
// plugin is why that is survivable. The fault being fixed happened because two
// places disagreed about a path and nothing noticed for three weeks; re-deriving
// the wrapper's environment test here is a real answer but it re-creates that
// shape, one wrapper release away from splitting again the same silent way.
//
// So the guess is checked against the resolved truth. Nitro puts the deployed
// directory on the client environment's config, and by `configResolved` that
// value is settled, so the two can be compared and a mismatch can end the build
// instead of shipping a 404 nobody sees. Cheap, and it converts the one
// remaining fragility from silent to loud.
//
// It does NOT throw when the value cannot be found. An upstream rename of the
// environments API is not a reason to make this repo unbuildable, and the
// warning still says the check did not run -- which is the distinction the
// migration rules in CLAUDE.md ask for: "no experiment was run" must never look
// like "the experiment passed".
function theWorkerHasToLandWhereTheClientBuildDoes() {
  return {
    name: "the-worker-has-to-land-where-the-client-build-does",
    apply: "build" as const,
    configResolved(config: {
      environments?: Record<string, { consumer?: string; build?: { outDir?: string } }>;
    }) {
      const client = config.environments?.client;
      const resolved = client?.build?.outDir;
      if (!resolved) {
        console.warn(
          "[pwa] could not read the client environment's resolved outDir, so " +
            "nothing verified that the service worker is being written to the " +
            "directory this build deploys. If /sw.js 404s, start here.",
        );
        return;
      }
      const expected = path.resolve(import.meta.dirname, PWA_OUT_DIR);
      const actual = path.resolve(import.meta.dirname, resolved);
      if (expected !== actual) {
        throw new Error(
          `[pwa] the service worker would be written to ${expected} but this ` +
            `build deploys ${actual}, so /sw.js would 404 in production.\n\n` +
            `  NATIVE_BUILD=${NATIVE_BUILD ? "1" : "0"} HOSTED_BUILD=${HOSTED_BUILD ? "1" : "0"}\n\n` +
            `This is the fault that took three weeks to find, caught at build ` +
            `time instead. PWA_OUT_DIR in vite.config.ts derives the deployed ` +
            `directory from the host wrapper's environment test; if the wrapper ` +
            `changed how it sets Nitro's output paths, that derivation is what ` +
            `needs updating.`,
        );
      }
    },
  };
}

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

// ── WHICH SUPABASE A NATIVE BUILD TALKS TO (#623) ─────────────────────────
//
// src/integrations/supabase/client.ts reads VITE_SUPABASE_URL only in `vite
// dev`, so until this setting existed every native build, staging included,
// signed in to and wrote to the production project. These two sit beside
// NATIVE_API_ORIGIN and work the same way: read at build time, baked in, and
// defined for the native build only, so the hosted build is untouched.
//
//   NATIVE_SUPABASE_URL                Supabase URL the binary uses
//   NATIVE_SUPABASE_PUBLISHABLE_KEY    its anon key (set both or neither)
//   NATIVE_TARGET                      "production" (default) or "staging"
//
// The defined names are NOT VITE_-prefixed on purpose. Vite copies every
// VITE_* variable in the environment into import.meta.env, so a VITE_ name
// would let any build environment, Lovable's included, repoint the web app.
// A plain name exists only where this define puts it.
//
// A staging build must name all three backends itself, and none may be a
// production host: a staging binary that quietly fell back to production is
// the exact fault this closes. scripts/native-prod-hosts.mjs then checks the
// built bundle, because a config that says staging and a bundle that says
// staging are two different claims.
const PROD_SUPABASE_REF = "vsxzrbxublqrcfnxfwcu";
const NATIVE_TARGET = NATIVE_BUILD ? process.env.NATIVE_TARGET || "production" : "";
const NATIVE_STAGING = NATIVE_TARGET === "staging";
const NATIVE_SUPABASE_URL = NATIVE_BUILD ? (process.env.NATIVE_SUPABASE_URL || "").trim() : "";
const NATIVE_SUPABASE_PUBLISHABLE_KEY = NATIVE_BUILD
  ? (process.env.NATIVE_SUPABASE_PUBLISHABLE_KEY || "").trim()
  : "";

function isProdHost(value: string): boolean {
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    throw new Error(`[native build] ${JSON.stringify(value)} is not a URL`);
  }
  return (
    host === "houndstack.com" ||
    host.endsWith(".houndstack.com") ||
    host.includes(PROD_SUPABASE_REF)
  );
}

function keyIsForProd(key: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
    return payload?.ref === PROD_SUPABASE_REF;
  } catch {
    return false;
  }
}

if (NATIVE_BUILD) {
  const problems: string[] = [];
  if (NATIVE_TARGET !== "production" && NATIVE_TARGET !== "staging") {
    problems.push(
      `NATIVE_TARGET must be "production" or "staging", got ${JSON.stringify(NATIVE_TARGET)}`,
    );
  }
  if (Boolean(NATIVE_SUPABASE_URL) !== Boolean(NATIVE_SUPABASE_PUBLISHABLE_KEY)) {
    problems.push(
      "set NATIVE_SUPABASE_URL and NATIVE_SUPABASE_PUBLISHABLE_KEY together: a URL with the other project's key cannot sign anyone in",
    );
  }
  if (NATIVE_STAGING) {
    const origin = (process.env.NATIVE_API_ORIGIN || "").trim();
    if (!origin) problems.push("a staging build needs NATIVE_API_ORIGIN (the staging web app)");
    else if (isProdHost(origin)) problems.push(`NATIVE_API_ORIGIN is a production host: ${origin}`);
    if (!NATIVE_SUPABASE_URL) problems.push("a staging build needs NATIVE_SUPABASE_URL");
    else if (isProdHost(NATIVE_SUPABASE_URL)) {
      problems.push(`NATIVE_SUPABASE_URL is a production host: ${NATIVE_SUPABASE_URL}`);
    }
    if (!NATIVE_SUPABASE_PUBLISHABLE_KEY)
      problems.push("a staging build needs NATIVE_SUPABASE_PUBLISHABLE_KEY");
    else if (keyIsForProd(NATIVE_SUPABASE_PUBLISHABLE_KEY)) {
      problems.push("NATIVE_SUPABASE_PUBLISHABLE_KEY is the production project's key");
    }
  }
  if (problems.length) {
    throw new Error(`[native build] refusing to build:\n  - ${problems.join("\n  - ")}`);
  }
}

// In a staging build the app's own origin is the staging web app, so the
// places in src/ that name the production one (app-origin, the deep-link
// host, the page's og:url, the footer) are pointed there at compile time.
// Email addresses are left alone: a mailbox is not a host the app connects
// to. api.houndstack.com is deliberately NOT rewritten: the Supabase URL has
// to come from NATIVE_SUPABASE_URL above, and if it ever survives into the
// bundle the post-build scan fails rather than this hiding it.
const STAGING_APP_ORIGIN = NATIVE_STAGING ? NATIVE_API_ORIGIN.replace(/\/+$/, "") : "";
const PROD_HOST_IN_SOURCE = /(?<![@\w-])(https?:\/\/)?((?:[a-z0-9-]+\.)*)houndstack\.com\b/gi;

// ── WHICH BUILD AN ERROR CAME FROM ────────────────────────────────────────
//
// Error monitoring (src/lib/monitoring) labels every event with this, so an
// error can be tied to the commit that shipped it and Sentry can say "first
// seen in this release". An explicit SENTRY_RELEASE wins; otherwise the commit
// from whichever CI is building (Xcode Cloud sets CI_COMMIT, GitHub Actions
// GITHUB_SHA), then the local checkout. "" when none of those exist, which
// is never an error: the event is simply sent without a release.
//
// Read at build time and never required. No step here needs a secret, and
// none does: a commit id is not one.
function sentryRelease(): string {
  const explicit = process.env.SENTRY_RELEASE?.trim();
  if (explicit) return explicit;
  const sha = (process.env.CI_COMMIT || process.env.GITHUB_SHA || "").trim();
  if (sha) return `houndstack@${sha.slice(0, 12)}`;
  try {
    const head = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
      .toString()
      .trim();
    return head ? `houndstack@${head}` : "";
  } catch {
    return "";
  }
}
const SENTRY_RELEASE = sentryRelease();

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
    build: {
      // ── THE BUILD ABORTS AT RANDOM INSIDE THE CSS MINIFIER ─────────────
      //
      // CI run 34252803499 on commit 1dc09931 of `main` died in the build
      // step with SIGABRT and no JS frame:
      //
      //     ✓ 755 modules transformed.
      //     thread '<unnamed>' panicked at .../src/printer.rs:350:30:
      //     byte index 2 is out of bounds of ``
      //     72429 Abort trap: 6   vite build
      //
      // That is a lightningcss bug, not a report about this stylesheet. Line
      // 350 of printer.rs in the version we resolve (1.32.0) is, verbatim:
      //
      //     serialize_name(&ident[2..], self)?;
      //
      // inside `Printer::write_dashed_ident`, and column 30 is the slice. It
      // strips the leading `--` off a custom property name, so it panics on
      // exactly one input: an ident whose backing string is EMPTY. No parse
      // of real CSS produces one — every dashed ident starts with `--` and is
      // therefore at least two bytes — which is consistent with the failure
      // being nondeterministic rather than input-dependent: the same content
      // passed the same step an hour earlier, the failing commit builds clean
      // locally, and that commit touched no CSS at all.
      //
      // ── WHY NOT JUST UPGRADE LIGHTNINGCSS, WHICH WOULD BE CHEAPER ──────
      //
      // Because there is no fixed version to upgrade to. That line is
      // BYTE-IDENTICAL in 1.32.0, in 1.33.0 (latest at time of writing) and
      // on master — same function, same line number, same unguarded
      // `&ident[2..]` — so pinning forward buys nothing. Neither changelog
      // mentions a printer panic and the issue tracker has no report of this
      // one. Checked, not assumed; re-check before reverting this.
      //
      // ── WHAT THIS LINE ACTUALLY BUYS, WHICH IS NOT IMMUNITY ────────────
      //
      // Vite 8 inverted the default: `minifyCSS` uses lightningcss unless
      // `cssMinify` is the literal string "esbuild" (see its
      // `if (config.build.cssMinify === "esbuild")` — `true` falls through to
      // lightningcss). So this project was on lightningcss for minification
      // without ever asking for it. This opts out.
      //
      // It removes ONE of THREE lightningcss entry points. `npm run build`
      // makes twelve calls into it, four from each of:
      //
      //   1. @tailwindcss/vite's own `optimize()`, during `transform`
      //   2. Vite's `compileLightningCSS` (bundleAsync), during `transform`,
      //      because @lovable.dev/vite-tanstack-config sets
      //      `css.transformer: "lightningcss"` for dev/build parity
      //   3. Vite's `minifyCSS`, during renderChunk — this one, now esbuild
      //
      // Neither 1 nor 2 is reachable from here without changing the CSS
      // pipeline itself: (1) takes no options through the wrapper, and
      // turning it off would also drop its nesting flattening and vendor
      // prefixing; (2) is a deliberate choice by the wrapper. So this is a
      // reduction in exposure, NOT a proof that the build can no longer
      // abort. If it aborts again, that is where to look — and the stack
      // being identical will not mean this change failed.
      //
      // The reason to believe #3 is the one that panicked is the CI log's
      // ordering: 1 and 2 both run inside `transform`, and the panic printed
      // after `✓ 755 modules transformed.`, which is the line that marks the
      // end of that phase. Confirmed against the local call order by
      // instrumenting lightningcss: minifyCSS is last in each of the two
      // build passes. That is an inference from ordering, not a repro. The
      // panic was never reproduced locally: forty consecutive builds BEFORE
      // this change were clean, which puts the local rate under 1 in 40 and
      // means the twelve clean builds after it prove nothing on their own.
      // Only CI staying green over weeks will.
      //
      // ── WHAT IT COSTS, MEASURED — WHICH IS NOTHING ─────────────────────
      //
      // The trade was expected to be worse minification for a build that
      // does not abort. It was measured instead of asserted, and there is no
      // trade: the deployed CSS got SMALLER.
      //
      //                        lightningcss      esbuild        delta
      //   assets/styles.css    145,406 raw       144,332 raw    -1,074
      //                         22,912 gzip       22,854 gzip      -58
      //   assets/map-tiles.css  15,095 raw        15,092 raw         -3
      //                          6,393 gzip        6,394 gzip        +1
      //   total                160,501 raw       159,424 raw    -1,077 (-0.67%)
      //                         29,483 gzip       29,428 gzip      -55 (-0.19%)
      //
      // Nothing was dropped to get there. The two files have the same 1,962
      // rule blocks, the same 293 distinct custom-property names (compared
      // as sets, in both directions), and the same 89 `@property`, 25
      // `@media`, 149 `@supports` and 7 `@keyframes`. The whole difference is
      // four trailing semicolons and this, which lightningcss emitted:
      //
      //   a{color:inherit;-webkit-text-decoration:inherit;
      //     -webkit-text-decoration:inherit;-webkit-text-decoration:inherit;
      //     -webkit-text-decoration:inherit;-webkit-text-decoration:inherit;
      //     text-decoration:inherit}
      //
      // Five identical prefixed declarations it did not dedupe; esbuild
      // collapses them to one. No prefix coverage is lost — the `-webkit-`
      // form is still there, and so is the unprefixed one after it.
      //
      // Numbers are from this commit's own build; re-measure rather than
      // trusting them if the stylesheet has moved on.
      //
      // ── AND WHY esbuild IS NOW IN devDependencies ──────────────────────
      //
      // Vite 8 lists it as an OPTIONAL peer, so nothing installs it on
      // Vite's behalf; `minifyCSS` does a lazy `import("esbuild")` that
      // throws if it is absent. It was only present here because
      // `react-email` happens to depend on a version that hoists to the root
      // and dedupes into Vite's range. That is the same shape as the /sw.js
      // fault documented at the top of this file — a contract we depend on
      // and do not state — so the line above is now backed by a declared
      // dependency rather than by somebody else's dependency tree.
      cssMinify: "esbuild",
      ...(NATIVE_BUILD ? { outDir: "dist-native" } : {}),
    },
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
    //
    // The one key defined for BOTH builds is the monitoring release above. It
    // is read only by src/lib/monitoring/sentry-browser.ts (a lazy chunk) and
    // by the server's report.server.ts, so the entry chunk is unchanged by it.
    define: {
      "import.meta.env.VITE_SENTRY_RELEASE": JSON.stringify(SENTRY_RELEASE),
      ...(NATIVE_BUILD
        ? {
            "import.meta.env.VITE_NATIVE_API_ORIGIN": JSON.stringify(NATIVE_API_ORIGIN),
            // See NATIVE_SUPABASE_URL above. "" means "use the literal in
            // client.ts", which is production.
            "import.meta.env.HS_NATIVE_SUPABASE_URL": JSON.stringify(NATIVE_SUPABASE_URL),
            "import.meta.env.HS_NATIVE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(
              NATIVE_SUPABASE_PUBLISHABLE_KEY,
            ),
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
            // See FCM_CONFIGURED above. "" when the Firebase config is absent,
            // which makes registerPushNotifications skip register() on Android
            // rather than crash the app.
            "import.meta.env.VITE_FCM_CONFIGURED": JSON.stringify(FCM_CONFIGURED ? "1" : ""),
          }
        : {}),
    },
    resolve: {
      alias: {
        // ── THE SAAS PURCHASE UI IS NOT IN THE STORE BINARY ──────────────
        //
        // The runtime gate stops it rendering; this stops it shipping. In a
        // NATIVE_BUILD the plan picker module resolves to a stub that renders
        // the "managed outside the mobile app" note, so the plan cards, the
        // "Choose plan" labels and the inline subscription checkout are absent
        // from the artifact rather than merely unreachable in it.
        //
        // Stripe itself is untouched and must be: six other files use it to
        // take money from the tenant's OWN customers, which is the half of
        // app-store-billing.ts that is deliberately never gated.
        ...(NATIVE_BUILD
          ? {
              "@/components/billing/PlanPicker": path.resolve(
                import.meta.dirname,
                "src/components/billing/PlanPicker.native-stub.tsx",
              ),
            }
          : {}),
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
      // ── THE ALIAS BELOW WAS DEAD, AND THE BINARY SHIPPED THE REAL ONE ──
      //
      // `resolve.alias` carried a NATIVE_BUILD entry mapping
      // "@/components/billing/PlanPicker" to the store stub. It never fired.
      // @lovable.dev/vite-tanstack-config sets `alias: { "@": cwd/src }` and
      // then mergeConfig's ours on top; Vite turns object aliases into an
      // ORDERED ARRAY matched first-wins, and "@" prefix-matches
      // "@/components/billing/PlanPicker" before the specific key is reached.
      //
      // So the real PlanPicker -- plan catalog query, Subscribe button,
      // confirmPayment -- was in the shipped bundle the whole time, while
      // docs/app-store-submission.md said the purchase UI was "removed from
      // the binary". The runtime gate still held, so nothing was reachable;
      // the BUILD-TIME removal simply was not happening.
      //
      // Worse, the check that was supposed to prove it looked for
      // `stripeAppearance`, which is absent from the bundle for an unrelated
      // reason -- so the assertion passed while the module shipped. That is
      // exactly the shape this repo warns about: "passed" and "not checked"
      // looking alike.
      //
      // A plugin rather than an alias, because `enforce: "pre"` runs before
      // alias resolution and cannot be defeated by merge order.
      ...(NATIVE_BUILD
        ? [
            {
              name: "houndstack:store-build-drops-the-plan-picker",
              enforce: "pre" as const,
              resolveId(source: string) {
                // Match the RESOLVED path, not the bare specifier. The
                // wrapper's `@` alias is applied before this hook sees the
                // import, so `source` arrives as
                // `/…/src/components/billing/PlanPicker` — matching
                // "@/components/billing/PlanPicker" here never fires. Proven
                // by logging what actually arrives, which is the only reason
                // this is the fourth attempt and not the fortieth.
                const isPlanPicker =
                  /[\\/]src[\\/]components[\\/]billing[\\/]PlanPicker(\.tsx)?$/.test(source);
                return isPlanPicker
                  ? path.resolve(
                      import.meta.dirname,
                      "src/components/billing/PlanPicker.native-stub.tsx",
                    )
                  : null;
              },
            },
          ]
        : []),
      // See STAGING_APP_ORIGIN above. Staging native builds only.
      ...(NATIVE_STAGING
        ? [
            {
              name: "houndstack:staging-build-names-no-production-host",
              enforce: "pre" as const,
              transform(code: string, id: string) {
                if (!/[\\/]src[\\/][^?]*\.(tsx?|jsx?)(\?|$)/.test(id)) return null;
                if (!code.includes("houndstack.com")) return null;
                const stagingHost = new URL(STAGING_APP_ORIGIN).host;
                const out = code.replace(PROD_HOST_IN_SOURCE, (m, scheme, sub) => {
                  if (/^api\./i.test(sub)) return m;
                  return scheme ? STAGING_APP_ORIGIN : stagingHost;
                });
                return out === code ? null : { code: out, map: null };
              },
            },
          ]
        : []),
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
        // See PWA_OUT_DIR at the top of this file. NOT a literal: the deployed
        // client directory differs between the hosted build and a laptop, and
        // hardcoding either one 404s the worker on the other.
        outDir: PWA_OUT_DIR,
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
          description: "The business system for recurring pet service companies",
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
      theWorkerHasToLandWhereTheClientBuildDoes(),
    ],
  },
});
