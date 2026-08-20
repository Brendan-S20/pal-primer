import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouteError, RouteNotFound } from "./components/RouteError";
import {
  isImpersonationExpiredError,
  notifyImpersonationExpired,
} from "./lib/impersonation-expiry";

export const getRouter = () => {
  // BUG-2: the server rejects any request made under an expired impersonation
  // session. Catching it centrally — for both reads and writes — is what turns
  // that rejection into the explicit "session ended" state instead of a page
  // that quietly stops loading data.
  const onError = (error: unknown) => {
    if (isImpersonationExpiredError(error)) notifyImpersonationExpired();
  };

  const queryClient = new QueryClient({
    queryCache: new QueryCache({ onError }),
    mutationCache: new MutationCache({ onError }),
    defaultOptions: {
      queries: {
        // Offline reads (Mobile Phase 3): React Query's default
        // networkMode 'online' does not fail an offline query — it PAUSES it.
        // A tech launching the app in a dead zone therefore sat on a spinner
        // forever, with the day's route already on the device and unreachable.
        // 'offlineFirst' lets the fetch be attempted, so it can fail fast and
        // the restored cache (or the "no saved copy" screen) renders instead.
        // Online this changes nothing: with a connection both modes fetch.
        networkMode: "offlineFirst",
        retry: (failureCount, _error) => {
          // ...but 'offlineFirst' only ungates the FIRST attempt; retries pause
          // again while offline, which puts the spinner right back. When the
          // device says it has no network, don't retry at all. Online, this is
          // React Query's own default of three attempts.
          if (isDefinitelyOffline()) return false;
          return failureCount < 3;
        },
      },
      // Mutations are deliberately left on the default networkMode: field
      // writes already queue in IndexedDB (lib/offline/queue.ts), and money
      // actions must not fire optimistically off a dead connection.
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    // G3 (portal bottom-nav dead click): route components are code-split, and
    // preloading was never enabled (defaultPreloadStaleTime was tuned but
    // defaultPreload left at its default of false, so links never preloaded).
    // A first tap on a nav link committed the URL — the tab highlighted — but
    // the outlet kept the old content until the route's JS chunk finished
    // downloading, which on a phone reads as a dead tap. Preload on intent so
    // chunks are in flight before the tap completes.
    defaultPreload: "intent",
    defaultPreloadStaleTime: 0,
    defaultErrorComponent: RouteError,
    defaultNotFoundComponent: RouteNotFound,
  });

  return router;
};
