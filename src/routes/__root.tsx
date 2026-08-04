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
import { Toaster } from "sonner";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { ImpersonationBanner } from "../components/ImpersonationBanner";
import "../lib/i18n";
import { appOrigin, appUrl } from "@/lib/app-origin";

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
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "HoundStack - Field Service App" },
      {
        name: "description",
        content:
          "HoundStack runs routes, recurring visits, per-dog billing, and the field app for pet waste removal companies.",
      },
      { name: "robots", content: "noindex" },
      { property: "og:site_name", content: "HoundStack" },
      { property: "og:type", content: "website" },
      { property: "og:title", content: "HoundStack - Field Service App" },
      { name: "twitter:title", content: "HoundStack - Field Service App" },
      { name: "description", content: "HoundStack runs routes, recurring visits, per-dog billing, and the field app for pet waste removal companies." },
      { property: "og:description", content: "HoundStack runs routes, recurring visits, per-dog billing, and the field app for pet waste removal companies." },
      { name: "twitter:description", content: "HoundStack runs routes, recurring visits, per-dog billing, and the field app for pet waste removal companies." },
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
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
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

  // Register the guarded service worker on real hosts only (see src/pwa/register.ts).
  useEffect(() => {
    import("../pwa/register").then((m) => m.registerPwa());
  }, []);

  // Android hardware back button (native shell only — web no-op): pop in-app
  // history, minimize the app at the root. Lives on the root route so it also
  // covers the client portal, not just the authenticated shell.
  useEffect(() => {
    let removed = false;
    let remove: (() => void) | undefined;
    import("../lib/native")
      .then((m) => m.initBackButton())
      .then((r) => {
        if (removed) r();
        else remove = r;
      })
      .catch(() => {});
    return () => {
      removed = true;
      remove?.();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ImpersonationBanner />
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <Outlet />
      <Toaster position="top-center" richColors />
    </QueryClientProvider>
  );
}
