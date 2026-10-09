import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { initClientMonitoring, reportBoundaryError } from "../lib/monitoring/client";
import { ImpersonationBanner } from "../components/ImpersonationBanner";
import { RouteProgress } from "../components/motion/RouteProgress";
import "../lib/i18n";
import { appOrigin, appUrl } from "@/lib/app-origin";
import { THEME_BOOT_SCRIPT, applyTheme, followSystemTheme, readThemePref } from "@/lib/theme";

// Error monitoring starts here, at module load on the client, so it is armed
// before hydration rather than after the first effect. Off (no download, no
// request) in dev and test; see lib/monitoring/config.ts.
if (typeof window !== "undefined") initClientMonitoring();

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
    reportBoundaryError(error, "tanstack_root_error_component");
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        // NATIVE ONLY — a full-screen WebView is the only surface here with a
        // safe area to opt into.
        //
        // viewport-fit=cover is what makes env(safe-area-inset-*) resolve to
        // anything other than 0 on iOS. Without it every safe-area rule in
        // this codebase — the tab bar's pb-[env(safe-area-inset-bottom)], the
        // sheets, my-day's header padding — is silently inert inside the
        // native shell, and the class-list tests still pass because the class
        // IS there. iOS QA 2026-08-20 measured the bottom tab bar ending 9.3pt
        // from the screen edge on a device whose inset is 34pt.
        //
        // Gated because it does NOT belong to the hosted app: `cover` changes
        // how a page lays out in an installed PWA, and the web product has not
        // asked for that. When the PWA is developed this is the line to
        // revisit — see src/lib/native-build.ts.
        content: IS_NATIVE_BUNDLE
          ? "width=device-width, initial-scale=1, viewport-fit=cover"
          : "width=device-width, initial-scale=1",
      },
      { title: "HoundStack" },
      {
        name: "description",
        content:
          "Scheduling, routing, billing and payments, a client portal and a field app for recurring pet service businesses.",
      },
      { name: "robots", content: "noindex" },
      // Matches manifest.theme_color in vite.config.ts (brand cream). Chrome
      // reads the manifest for the installed window and this tag for the
      // browser tab, so the two have to agree or the address bar and the
      // installed title bar are different colours.
      { name: "theme-color", content: "#fdfaf1" },
      { property: "og:site_name", content: "HoundStack" },
      { property: "og:type", content: "website" },
      {
        property: "og:title",
        content: "HoundStack: run your whole recurring pet service business from one app",
      },
      {
        name: "twitter:title",
        content: "HoundStack: run your whole recurring pet service business from one app",
      },
      {
        name: "description",
        content:
          "Scheduling, routing, billing and payments, a client portal and a field app for recurring pet service businesses.",
      },
      {
        property: "og:description",
        content:
          "Scheduling, routing, billing and payments, a client portal and a field app for recurring pet service businesses.",
      },
      {
        name: "twitter:description",
        content:
          "Scheduling, routing, billing and payments, a client portal and a field app for recurring pet service businesses.",
      },
      { property: "og:image", content: appUrl("/og-image.png") },
      { property: "og:image:width", content: "1200" },
      { property: "og:image:height", content: "630" },
      { property: "og:url", content: appOrigin() },
      { name: "twitter:image", content: appUrl("/og-image.png") },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "icon", type: "image/x-icon", href: "/favicon.ico", sizes: "48x48" },
      { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
      // THE WEBMANIFEST WAS SERVED AND NOTHING POINTED AT IT.
      //
      // vite-plugin-pwa generates /manifest.webmanifest and injects the link
      // that references it into index.html. This app is server-rendered and
      // the web build emits no index.html at all, so the generation half ran
      // and the injection half had nowhere to run. Measured against the live
      // site on 2026-09-09: /manifest.webmanifest answers 200, and the HTML at
      // /auth carries exactly four <link> rels -- stylesheet, two icons and
      // apple-touch-icon. No manifest among them.
      //
      // A manifest a document does not link is not read, so Chrome and Edge
      // had no installability signal and never offered "Install app" on any
      // surface. That is independent of the /sw.js 404: fixing the worker
      // would not have made the app installable on its own, and this does not
      // depend on the worker being fixed first.
      //
      // Not gated on the native bundle even though the store app is already
      // installed, because a manifest whose scope does not match a
      // capacitor://localhost document is ignored by the WebView rather than
      // acted on -- gating it would add a branch to guard against nothing.
      { rel: "manifest", href: "/manifest.webmanifest" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    // The server renders English, left to right, because it cannot see the
    // language this device picked (localStorage). lib/i18n sets `lang` and
    // `dir` on this element before hydration; suppressHydrationWarning covers
    // this element's own attributes and nothing below it.
    //
    // suppressHydrationWarning: the boot script below may add `dark` to this
    // element's class before React hydrates it, which is the point of it.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Before anything paints, so a dark-mode device never flashes white.
            See src/lib/theme.ts. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  // The device's light/dark choice (Settings → Preferences). The boot script
  // in <head> already applied it before paint; this keeps "System" following
  // the phone when it flips at sunset.
  useEffect(() => {
    applyTheme(readThemePref());
    return followSystemTheme();
  }, []);

  // Register the guarded service worker on real hosts only (see src/pwa/register.ts).
  useEffect(() => {
    import("../pwa/register").then((m) => m.registerPwa());
  }, []);

  // Take the native splash down once the app has actually painted, rather than
  // on the config's timer. On the root route so it covers every surface a cold
  // launch can land on — /auth is the one the native shell actually opens.
  //
  // Two rAFs: the first is scheduled before the next paint, the second runs
  // after it, so by the time this fires there is real UI underneath the splash.
  // Hiding on mount alone would swap the splash for an unpainted frame, which
  // is the white gap this exists to remove, just shorter.
  //
  // ── AND NOT UNTIL THE FIRST ROUTE HAS RESOLVED ─────────────────────────
  //
  // The root painting is not the app painting. A signed-in launch lands on a
  // page under _authenticated, whose beforeLoad (session, second step,
  // organisation) runs after the root mounts; until it settles the outlet
  // had nothing to draw, so the splash came down onto an empty frame. So this
  // waits for the router to go idle, and only then for the paint. The shell
  // now has a skeleton for that window too (ShellPending), so a launch that
  // is slow to resolve is still not white: after SPLASH_CEILING_MS the splash
  // lifts onto the skeleton rather than sitting on the logo for the config's
  // 20-second backstop.
  const router = useRouter();
  useEffect(() => {
    let cancelled = false;
    let raf = 0;
    let unsubscribe: (() => void) | undefined;
    const hide = () => {
      if (cancelled) return;
      cancelled = true;
      unsubscribe?.();
      clearTimeout(ceiling);
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          import("../lib/native").then((m) => m.hideSplashScreen()).catch(() => {});
        });
      });
    };
    const SPLASH_CEILING_MS = 6000;
    const ceiling = setTimeout(hide, SPLASH_CEILING_MS);
    if (router.state.status === "idle") hide();
    else unsubscribe = router.subscribe("onResolved", hide);
    return () => {
      cancelled = true;
      unsubscribe?.();
      clearTimeout(ceiling);
      cancelAnimationFrame(raf);
    };
  }, [router]);

  // iOS only applies `:active` styles on a page that listens for touches.
  // One passive no-op listener is the whole of the pressed state on every
  // button in the app (ui/button.tsx, `active:scale-…`).
  useEffect(() => {
    const noop = () => {};
    document.addEventListener("touchstart", noop, { passive: true });
    return () => document.removeEventListener("touchstart", noop);
  }, []);

  // Android hardware back button (native shell only — web no-op): close the
  // open dialog or sheet, else pop in-app history, else background the app
  // from a start screen. See handleBackButton in src/lib/native.ts. Lives on
  // the root route so it also covers the client portal, not just the
  // authenticated shell.
  //
  // Android App Links in the same effect, for the same reason: a tapped
  // https://app.houndstack.com/<staff page> link arrives here whether or not
  // anyone is signed in, and the _authenticated guard takes it from there.
  useEffect(() => {
    let removed = false;
    const removers: Array<() => void> = [];
    const keep = (r: () => void) => {
      if (removed) r();
      else removers.push(r);
    };
    import("../lib/native")
      .then(async (m) => {
        keep(await m.initBackButton());
        keep(await m.initAppLinks((path) => router.history.push(path)));
      })
      .catch(() => {});
    return () => {
      removed = true;
      for (const r of removers) r();
    };
  }, [router]);

  return (
    <QueryClientProvider client={queryClient}>
      <RouteProgress />
      <ImpersonationBanner />
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      {/* Native only: a top-center toast at the default offset renders under
          the status clock and the Dynamic Island ("Already syncing" measured
          clipped behind both, iPhone 17 Pro sim, 2026-09-26). Same doctrine
          as PublicShell's inset: the web product's spacing stays exactly as
          it was, so the props are undefined outside the binary. */}
      <Toaster
        position="top-center"
        richColors
        offset={IS_NATIVE_BUNDLE ? { top: "calc(env(safe-area-inset-top) + 12px)" } : undefined}
        mobileOffset={
          IS_NATIVE_BUNDLE ? { top: "calc(env(safe-area-inset-top) + 12px)" } : undefined
        }
      />
    </QueryClientProvider>
  );
}
