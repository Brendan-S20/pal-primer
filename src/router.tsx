import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { refetchOnReturn } from "@/lib/query-refocus";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { RouteError, RouteNotFound } from "./components/RouteError";
import { RoutePending } from "./components/PageSkeletons";
import { installPageTransitions, pageViewTransition } from "./lib/motion/page-transitions";
import { PENDING_MIN_VISIBLE_MS, PENDING_SHOW_AFTER_MS } from "./lib/motion/pending";
import { guardRouterStartTransition } from "./lib/app-mounted";
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
        // Coming back to the app refetches only what is more than 30s old,
        // not everything on the screen at once (src/lib/query-refocus.ts).
        refetchOnWindowFocus: (query) => refetchOnReturn(query),
        retry: (failureCount, _error) => {
          // ...but 'offlineFirst' only ungates the FIRST attempt; retries pause
          // again while offline, which puts the spinner right back. When the
          // device says it has no network, don't retry at all. Online, this is
          // React Query's own default of three attempts.
          if (isDefinitelyOffline()) return false;
          return failureCount < 3;
        },
      },
      mutations: {
        // ── THE PREMISE THIS COMMENT USED TO STATE WAS FALSE ──────────────
        //
        // It said mutations were "deliberately left on the default
        // networkMode: field writes already queue in IndexedDB". They do not,
        // because the queue write lives INSIDE mutationFn — my-day's Complete
        // calls actions.complete() → runOrQueue → enqueueAction — and on the
        // default `"online"` mode React Query never calls mutationFn at all
        // while the device is offline. From query-core/retryer.js:
        //
        //   canFetch(mode) = mode === "online" ? onlineManager.isOnline() : true
        //   canStart = () => canFetch(config.networkMode) && config.canRun()
        //   if (canStart()) run()        // run() is the only caller of the fn
        //
        // So a tech who drives INTO a dead zone with My Day open taps Start,
        // the mutation is paused before any of our code runs, `isPending`
        // stays true so the button is disabled for ever, neither onSuccess nor
        // onError fires so there is no toast, and `scoop-offline.actions` stays
        // empty. Force-quit and the stop is gone. That is verbatim the symptom
        // run-or-queue.ts's own header says was fixed — a second, independent
        // cause with an identical face.
        //
        // Photos escaped it by accident: uploadPhoto is a plain async function
        // rather than a useMutation, so it was never paused. "Some operate as
        // needed, some don't" is exactly that split.
        //
        // A COLD launch already offline works, which is why this survived
        // testing: onlineManager initialises to `true` and only tracks events.
        //
        // ── AND THE MONEY CONCERN IS BETTER SERVED THIS WAY ───────────────
        //
        // The old note also worried that money actions "must not fire
        // optimistically off a dead connection". Pausing is WORSE for that: a
        // paused mutation resumes automatically when signal returns, so an
        // add-on charge could hit a customer's card unattended, minutes later,
        // with nobody watching. offlineFirst enters mutationFn, the request
        // fails, onError fires, and the tech is told. The queued kinds decide
        // for themselves inside runOrQueue, which is what its header says it
        // is for, and it rethrows server refusals rather than swallowing them.
        networkMode: "offlineFirst",
      },
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
    // ── PAGE TRANSITIONS ────────────────────────────────────────────────
    //
    // A navigation deeper or back goes through document.startViewTransition
    // where the browser has it (Chrome; Safari and WKWebView from 18). Tab
    // switches, filters and anything the platform already animated start no
    // transition at all; the decision is in src/lib/motion. Where the API
    // does not exist the router skips it and navigation is what it was.
    defaultViewTransition: pageViewTransition,
    // ── WHAT A SLOW NAVIGATION SHOWS ────────────────────────────────────
    //
    // A route that has not finished loading (its code, its beforeLoad) after
    // 300ms shows a skeleton of a page in its place, held for at least 200ms
    // so it cannot flash; RouteProgress in __root.tsx draws the bar along the
    // top on the same two numbers. Below 300ms nothing is drawn at all. The
    // router's own defaults were 1000 and 500, which left a second of a dead
    // tap before anything acknowledged it.
    defaultPendingMs: PENDING_SHOW_AFTER_MS,
    defaultPendingMinMs: PENDING_MIN_VISIBLE_MS,
    defaultPendingComponent: RoutePending,
  });

  if (typeof window !== "undefined") {
    installPageTransitions(router);
    // No router.startTransition call reaches <Transitioner>'s setState before
    // React has committed it (lib/app-mounted.ts, "THE THIRD PATH").
    guardRouterStartTransition(router);
  }

  return router;
};
