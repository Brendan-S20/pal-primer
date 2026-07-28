import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
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
