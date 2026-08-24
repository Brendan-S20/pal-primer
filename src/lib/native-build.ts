// Is this bundle the one inside the app binary?
//
// ── WHY THIS EXISTS, AND WHY IT IS BUILD-TIME ─────────────────────────────
//
// There is one codebase here and two products. `src/` is the web app that
// `main` deploys to app.houndstack.com; `ios/` is a native shell that bundles a
// BUILD of that same `src/`. `ios/App/App/public` is gitignored and regenerated
// by every `cap sync`, so there is nowhere in `ios/` to put a React, layout or
// behaviour change — anything of that kind has to live in `src/`, which means
// it ships to the live web app the moment it merges.
//
// That is the trap this flag is for. The iOS QA pass on 2026-08-20 found seven
// faults (docs/ios-qa-results.md). Several of the fixes are in shared code, and
// shipping them would have changed the hosted product — new safe-area padding,
// a different invoice layout on narrow screens, new timeouts on the sign-in
// path — as a side effect of work that was only ever about the phone. Owner
// decision (2026-08-21): the native fixes must not alter what is already set up
// on the web.
//
// BUILD-TIME, not `Capacitor.isNativePlatform()`, and the difference matters:
//
//   * A runtime check still SHIPS both branches to the web bundle. The web
//     product would then carry the native branch as dead code that a later
//     refactor could accidentally enable, and `.output` would differ from the
//     build that was reviewed.
//   * `import.meta.env.VITE_NATIVE_BUNDLE` is defined ONLY by the NATIVE_BUILD
//     branch of vite.config.ts. In the hosted build the key is absent, this
//     constant folds to `false`, and every `if (IS_NATIVE_BUNDLE)` below it is
//     dropped by the bundler. `npm run build` reproduces `.output` unchanged —
//     which is a claim you can check, not just assert: build once from a clean
//     tree, build again with this work applied, and diff. Only `.DS_Store`,
//     `nitro.json` and `server/index.mjs` may differ, because those three embed
//     a build timestamp and already differ between two identical builds.
//   * It is also the honest description of the situation. These branches are
//     not "am I on a touch device" — they are "am I the artifact that goes to
//     App Review", which is a property of the build, not of the runtime.
//
// ── WHEN NOT TO USE IT ────────────────────────────────────────────────────
//
// This is not a licence to fork the product. Reach for it only when a fix is
// genuinely about the native shell — a safe-area inset that only exists inside
// a full-screen WebView, a splash screen the web has no concept of — or when a
// shared fix is wanted on the phone before it is wanted on the web. A behaviour
// that SHOULD be the same everywhere belongs in shared code with no branch, and
// a platform rule about money belongs in src/lib/app-store-billing.ts, which
// gates on the running platform for reasons its own header explains.
//
// Each call site carries a one-line note saying which of those it is, so the
// next person can tell a deliberate divergence from an accident.

/** `true` only in the bundle produced by `npm run build:native`. Folds to a
 *  literal `false` in the hosted build, taking its branches with it. */
export const IS_NATIVE_BUNDLE: boolean = import.meta.env.VITE_NATIVE_BUNDLE === "1";

/**
 * Inline style that lets a STICKY TOP BAR sit under the status bar properly.
 *
 * `sticky top-0` inside a `viewport-fit=cover` WebView sticks to the PHYSICAL
 * top of the screen, so the bar's controls end up drawn underneath the clock
 * and the Dynamic Island the moment the page is scrolled. iOS QA 2026-08-21
 * caught it on Settings › Billing: "9:41" over the search icon, the signal and
 * battery glyphs over the weather and notification icons.
 *
 * The fix is NOT to push the bar below the inset — that leaves page content
 * scrolling through the status bar strip above it, which is what the build
 * before `viewport-fit=cover` did and looks equally wrong. A native top bar
 * extends UNDER the status bar and paints its own background there, with its
 * contents padded down clear of it. That is what this produces.
 *
 * `heightRem` is for bars with a FIXED height (`h-14` = 3.5): padding alone
 * would push the contents out of the bottom of a fixed box, so the height has
 * to grow by the same inset. Omit it for bars that size to their content.
 *
 * One helper rather than the same two declarations copied into three headers,
 * because there ARE three — the staff shell, the platform shell and My Day —
 * and My Day had already solved it alone. Two spellings of one idea is how the
 * other two came to be missing it.
 */
/**
 * Inline style that keeps the DESKTOP SIDEBAR out of the system's furniture.
 *
 * ── WHY THIS EXISTS, AND WHY IT IS A REGRESSION OF MY OWN MAKING ──────────
 *
 * `ios.contentInset` used to be `"always"`, which inset the whole document by
 * the safe area. Setting it to `"never"` moved the document to y=0 so the top
 * bar could extend under the status bar and paint its own background there —
 * which is what a native top bar does, and it recovered 62pt on every screen.
 *
 * It also moved the SIDEBAR to y=0, and nothing padded that back. The sidebar
 * is `md:flex` — it does not exist on a phone — so the fix was verified on the
 * one device class that cannot show the bug. QA on an iPad found it
 * immediately: `Link 'HoundStack' {{52,18},{90,20}}` with the clock drawn
 * across the wordmark, on every screen, in both orientations. The bottom was
 * the same story: the account row ended at y=1202 of 1210, putting a third of
 * a 44pt target inside the home-indicator gesture strip.
 *
 * Applied to the sidebar's inner flex column rather than its fixed container,
 * so `bg-sidebar` still paints edge to edge behind the status bar and only the
 * CONTENTS move — the same shape as nativeTopBarStyle above. Padding the fixed
 * container instead would leave an unpainted band at the top.
 */
export function nativeSidebarStyle(): Record<string, string> | undefined {
  if (!IS_NATIVE_BUNDLE) return undefined;
  return {
    paddingTop: "env(safe-area-inset-top)",
    paddingBottom: "env(safe-area-inset-bottom)",
  };
}

export function nativeTopBarStyle(heightRem?: number): Record<string, string> | undefined {
  if (!IS_NATIVE_BUNDLE) return undefined;
  return {
    paddingTop: "env(safe-area-inset-top)",
    ...(heightRem === undefined
      ? {}
      : { height: `calc(${heightRem}rem + env(safe-area-inset-top))` }),
  };
}
