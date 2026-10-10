import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatches,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import { clearPersistedReadCaches, ensureReadCachePersistence } from "@/lib/offline/read-cache";
import { useOfflineSignOut } from "@/hooks/useOfflineSignOut";
import { QueueSyncProvider } from "@/components/QueueSync";
import { resolveIdentity } from "@/lib/offline/identity";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { IS_NATIVE_BUNDLE, nativeTopBarStyle } from "@/lib/native-build";
import { getMyOrg } from "@/lib/org.functions";
import { getAccountLock } from "@/lib/account-lock.functions";
import { pathOpenWhenLocked } from "@/lib/account-lock";
import { AccountLockedShell } from "@/components/AccountLockedShell";
import { reportClientError, setMonitoringIdentity } from "@/lib/monitoring/client";
import { needsSecondStep } from "@/lib/mfa";
import { getPlatformContext } from "@/lib/platform.functions";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { SetupGuideBanner } from "@/components/SetupGuideBanner";
import { useHeaderPrefs } from "@/hooks/useHeaderPrefs";
import { useNotificationLanguageSync } from "@/hooks/useNotificationLanguageSync";
import { headerControlsForRole } from "@/lib/header-prefs";
import { InstallBanner } from "@/components/InstallBanner";
import { AppSidebar } from "@/components/AppSidebar";
import { AccountMenu } from "@/components/AccountMenu";
import { TrialBanner } from "@/components/TrialBanner";
import { MobileTabBar } from "@/components/MobileTabBar";
import { TimeClockSheetHost } from "@/components/TimeClock";
import { RouteLockScreenHost } from "@/components/my-day/RouteLockScreen";
import { sidebarDocksFrom, useTabletTier } from "@/hooks/useTabletTier";
import { useMyRole } from "@/hooks/useMyRole";
import { RoleGuard } from "@/components/RoleGuard";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationBell } from "@/components/NotificationBell";
import { RoutingRunIndicator } from "@/components/routes/RoutingRunIndicator";
import { WeatherPopover } from "@/components/WeatherPopover";
import { AnnouncementBanner } from "@/components/AnnouncementBanner";
import { SuspensionBanner } from "@/components/SuspensionBanner";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { HelpCircle, Search } from "lucide-react";
import { useBrandAccent } from "@/hooks/useBrandAccent";
import { PageShell } from "@/components/PageShell";
import { ShellPending } from "@/components/PageSkeletons";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context, location }) => {
    // NATIVE ONLY: not navigator.onLine — see lib/offline/connectivity.ts, a
    // WKWebView resumed from a dead zone can still be claiming to be online.
    // The hosted app keeps the property it has always read.
    const online = IS_NATIVE_BUNDLE
      ? !isDefinitelyOffline()
      : typeof navigator === "undefined" || navigator.onLine !== false;
    const identity = await resolveIdentity();
    if (!identity.ok) {
      // A REJECTED identity has to take the device copy with it.
      //
      // Revoking a session server-side (a tech leaves, an account is disabled)
      // did not reach the device: this redirect fires before
      // ensureReadCachePersistence below, so the onAuthStateChange SIGNED_OUT
      // backstop registered in there was never armed on that boot, and nothing
      // else sweeps at launch. The previous tech's route — addresses, gate
      // codes, lock box codes, access notes — stayed readable in localStorage
      // on the crew tablet until someone happened to sign out through the app.
      //
      // Only on `rejected`. A failure we could not reach the network to make
      // means we do not know anything, and deleting the day then would erase
      // the tech's route exactly when they need it most.
      if (identity.rejected) clearPersistedReadCaches();
      throw redirect({ to: "/auth" });
    }

    // Two-step sign-in: somebody who turned it on and signed in with the
    // password alone is asked for the code before anything loads. The
    // database refuses such a session anyway (public.mfa_satisfied); asking
    // first means they see a code box, not a workspace that will not load.
    // Read from the session on the device, so this works offline too.
    if (await needsSecondStep()) {
      throw redirect({ to: "/two-step", search: { next: location.href } });
    }

    // Put this user's persisted reads back into the query cache before anything
    // asks it a question. On a cold offline launch the ensureQueryData below
    // and every useQuery under this route resolve from what this restores;
    // doing it any later means the shell renders its empty state first.
    ensureReadCachePersistence(context.queryClient, identity.userId);

    // BUG-1: being signed in is not enough to render a tenant surface — every
    // page below this route reads org-scoped data, so an account with no
    // organization rendered tenant chrome around nothing (the repro was a
    // platform-admin account opening /settings/addons and getting an empty
    // settings page). Guarding here covers the WHOLE _authenticated tree
    // rather than the one route the repro happened to name.
    //
    // This shares the ["my-org"] cache entry with useMyRole(), so the shell
    // and every child that calls it reuse this fetch instead of adding one.
    // ensureQueryData answers from cache when one exists, so offline this is
    // the restored copy rather than a request that cannot be made.
    let org: Awaited<ReturnType<typeof getMyOrg>> | undefined;
    try {
      org = await context.queryClient.ensureQueryData({
        queryKey: ["my-org"],
        queryFn: () => getMyOrg(),
        staleTime: 60_000,
      });
    } catch (e) {
      if (online) throw e;
      // Offline with nothing cached: bouncing to /auth would strand a tech on
      // a sign-in form they cannot submit, so say what is actually wrong.
      throw new Error(
        "You're offline and this device has no saved copy of your workspace yet. Reconnect once to download your day.",
      );
    }
    if (!org?.organization) {
      // Platform admins have a real home; everyone else gets an explicit
      // terminal state rather than a blank tenant page.
      let isPlatformAdmin = false;
      try {
        isPlatformAdmin = !!(await getPlatformContext()).isPlatformAdmin;
      } catch {
        /* treat an unavailable check as "not an admin" — never fail open */
      }
      if (isPlatformAdmin) throw redirect({ to: "/platform" });
      // Off means off (20261009180000): the owner turned this person's access
      // off. The database refuses them everything already; this says so,
      // rather than drawing a workspace in which every list is empty.
      if (org?.accessTurnedOff) throw redirect({ to: "/access-off" });
      throw redirect({ to: "/no-workspace" });
    }

    // Error reports from here on name the user and org by id, and only by id.
    // Off in dev and test; see lib/monitoring/config.ts.
    setMonitoringIdentity({ userId: identity.userId, orgId: org.organization.id });

    // NP-12: a trial past day 14 with no plan, or a cancelled plan that has
    // ended, reaches Plan & billing and nothing else. The server refuses every
    // other function anyway (src/start.ts); this sends the person to the one
    // page that works instead of a workspace that will not load. Choosing a
    // plan reloads the app (PlanPaymentForm), and this asks again.
    //
    // A failed check lets the person through: offline there is nothing to pay
    // with, and online the server's refusal still holds.
    let lock: Awaited<ReturnType<typeof getAccountLock>> | null = null;
    try {
      lock = await context.queryClient.fetchQuery({
        queryKey: ["account-lock"],
        queryFn: () => getAccountLock(),
        staleTime: 15_000,
      });
    } catch {
      lock = null;
    }
    if (lock?.locked && lock.canChoosePlan && !pathOpenWhenLocked(location.pathname)) {
      throw redirect({ to: "/settings/billing" });
    }

    return { userId: identity.userId, user: identity.user, organization: org.organization, lock };
  },
  component: SignedInApp,
  // Client-only route: this is also what the server sends for a signed-in
  // URL and what a cold native launch paints while beforeLoad decides who
  // is signed in. See ShellPending.
  pendingComponent: ShellPending,
  // No minimum. On hydration the router gives the first `ssr: false` match a
  // timer of `pendingMinMs` (router-core ssr-client, setMatchForcePending),
  // and when it fires it calls router.startTransition, whose setState belongs
  // to a Transitioner that may not have committed yet: on a loaded machine
  // the route chunks take longer than 400ms and React logs "Can't perform a
  // React state update on a component that hasn't mounted yet". That was
  // the QA list's intermittent /invoices and /tax-reports failure.
  // Navigations keep the router default: this is the layout's own match.
  // → tests/a-timer-that-beat-the-first-render.test.ts
  pendingMinMs: 0,
});

function openPalette() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
}

/** The offline queue replays on launch and on every reconnect from here,
 *  whichever page is open — not only from My Day, where it used to be started.
 *  Outside AppShell so the shell and every page under it read the same one.
 *  See components/QueueSync.tsx. */
function SignedInApp() {
  return (
    <QueueSyncProvider>
      <AppShell />
    </QueueSyncProvider>
  );
}

function AppShell() {
  const router = useRouter();
  const { signOut, dialog: signOutDialog } = useOfflineSignOut();
  // Which optional header controls this person keeps. Answered from the
  // device, so the bar does not render full and then rearrange itself.
  const { prefs: headerPrefs } = useHeaderPrefs();
  // The language a push about this person's own route is written in.
  useNotificationLanguageSync(Route.useRouteContext().userId);

  // Native Capacitor bootstrap — theme-coherent status bar; no-ops on web.
  // Also registers APNs/FCM device tokens with our backend and routes push
  // notification taps to the deep link in the payload (e.g. /my-day?date=…).
  //
  // ── EACH STEP STANDS ALONE, AND A FAILURE IS REPORTED ───────────────────
  //
  // This was one `try { … } catch { /* ignore */ }` around the whole chain,
  // so a throw from the status bar (cosmetic) also skipped push registration,
  // and nothing anywhere said so. On 2026-10-04 an owner signed in on iOS,
  // never saw the notifications prompt, and push_subscriptions had no row:
  // whether iOS already held an answer or a step threw before the prompt was
  // unknowable, because both looked exactly the same. Now every step runs
  // whatever happened to the one before it (connectivity still goes before
  // push, so the order the comment below asks for holds), and a throw is
  // sent to monitoring tagged with the step it died in. Off in dev and tests.
  useEffect(() => {
    let cancelled = false;
    let removeDeepLinks: (() => void) | undefined;
    let removeConnectivity: (() => void) | undefined;
    let removePushRegistration: (() => void) | undefined;
    const step = async <T,>(name: string, run: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await run();
      } catch (e) {
        reportClientError(e, { area: "native_startup", step: name });
        return undefined;
      }
    };
    (async () => {
      const native = await step("load_native", () => import("@/lib/native"));
      if (!native) return;
      await step("status_bar", () => native.initStatusBar());
      if (!native.isNative()) return;
      // Before push: a resumed app that is actually offline should know it
      // before anything tries to talk to the server. No-ops on web.
      removeConnectivity = await step("connectivity", async () => {
        const conn = await import("@/lib/offline/connectivity");
        return conn.initNativeConnectivity();
      });
      removeDeepLinks = await step("push_deep_links", () =>
        native.initPushDeepLinks((path) => {
          if (!cancelled) router.history.push(path);
        }),
      );
      // The same call the Preferences card's button makes; the token is saved
      // through subscribeStaffNativePush in there, not here.
      const registered = await step("push_registration", () =>
        native.turnOnPushNotifications({ isCancelled: () => cancelled }),
      );
      removePushRegistration = registered?.cleanup;
      // Unmounted while registering: the cleanup below already ran.
      if (cancelled) removePushRegistration?.();
    })();
    return () => {
      cancelled = true;
      removeConnectivity?.();
      removeDeepLinks?.();
      removePushRegistration?.();
    };
  }, [router]);

  const handleSignOut = async () => {
    // Destroys the device's persisted day AND its queued field work — see
    // lib/offline/sign-out. Unsynced jobs are pushed first, and discarded only
    // if the tech says yes, so the redirect has to wait on the answer.
    if (await signOut()) window.location.href = "/auth";
  };

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  // My Day carries its own sticky header; wherever the app is in its phone
  // shape the shell header would stack a second bar on top of it (the audit's
  // "double header"), so it is hidden there.
  //
  // "Phone shape" is the tab bar's reach, not a fixed breakpoint. This read
  // `max-md:` from when the bar was `md:hidden` and that was the app's only
  // breakpoint; once field roles kept the bar to `lg`, a tech on an 800px crew
  // tablet got the double header back AND the tab bar over the bottom of the
  // page — both of the things the tablet tier was built to stop, on the one
  // route it was built for.
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  // Which column the matched page asked for — see PageShell. The deepest
  // match that says anything wins, so a layout route cannot widen its
  // children by accident and a child can still ask for itself.
  const pageWidth =
    useMatches({
      select: (ms) =>
        ms
          .map((m) => m.staticData?.pageWidth)
          .filter(Boolean)
          .pop(),
    }) ?? "standard";
  const isMyDay = pathname === "/my-day" || pathname.startsWith("/my-day/");

  const brand = useBrandAccent();
  // Q-2's tablet tier: the tab bar's reach, this padding, and the header above
  // are one decision, so they all read it from here rather than each writing a
  // breakpoint of their own. Both class strings are spelled out in full —
  // Tailwind scans source for literal class names and cannot see an assembled
  // one.
  const tier = useTabletTier();
  const { mainBottomPadding, barThroughTablet } = tier;
  const myDayHeaderHidden = barThroughTablet ? "max-lg:hidden" : "max-md:hidden";

  // ── THE BAR THAT APPEARED AND DISAPPEARED AS YOU WALKED ─────────────────
  //
  // This header was hidden on My Day and nowhere else, so a technician moving
  // between their own four tabs -- Today, Waste log, Alerts, More -- watched a
  // 56px bar with a search field in it slide in and out from under their
  // thumb. Reported as "it pops-up the search bar, that's not necessary... it
  // should be generally fluid".
  //
  // It is not necessary, and that is the whole argument. Wherever the tab bar
  // reaches, everything this header offers a TECH is already one tap away in
  // it: Alerts is the bell, More is the sidebar, and the sidebar trigger is
  // already hidden when the phone is set to bottom navigation. What is left is
  // the command palette, which is a keyboard affordance on a device with no
  // keyboard, over a product a tech navigates with four tabs.
  //
  // Office roles keep the header everywhere. They have eleven destinations and
  // a different bar, and search is how they reach a client by name -- the
  // complaint was never theirs, and taking it from them to make one rule
  // shorter would be a worse product for a saving nobody asked for.
  const { role } = useMyRole();
  // Help and Weather are office controls: a tech's header has neither, and
  // their Preferences offer no switch for them.
  const roleControls = headerControlsForRole(role);
  // The sidebar docks where the tab bar stops, so 767, 768 and 1023 each get
  // exactly one navigation. See sidebarDocksFrom. The bar renders on the same
  // two conditions MobileTabBar and the JSX below apply: a known role, and
  // bottom navigation chosen.
  const docksFrom = sidebarDocksFrom(tier, !!role && headerPrefs.phoneNav === "bottom");
  const shellHeaderHidden = role === "tech" ? myDayHeaderHidden : isMyDay ? myDayHeaderHidden : "";

  // The header was also doing a second job nobody asked it to: on a native
  // build it carries `nativeTopBarStyle`, so it is what holds the page clear of
  // the status bar. My Day already knew that -- it draws its own bar with the
  // same helper, which is why hiding the shell one there never pushed anything
  // under the clock. /waste-log and /neighbors have no such bar of their own,
  // so they need the inset here or the first row of the page renders under the
  // time and the battery.
  //
  // Width-matched to `shellHeaderHidden` rather than applied always, because
  // above the breakpoint the header IS rendered and would then be padded twice.
  //
  // NOT on My Day, which draws its own sticky bar carrying the same inset
  // (the paragraph above says so, and the condition below used to ignore
  // it): both applied there, so My Day's title sat one whole status-bar
  // inset, ~57pt measured on an iPhone 17 Pro, lower than every other tab's.
  // A tech flicking between Today and Waste log watched the page jump. On
  // the web the inset is 0, so this changes nothing there.
  //
  // The inset ALONE since 2026-10-02: the 1rem it used to add is PageShell's
  // own top padding now, which every page gets whether or not the header is
  // hidden.
  const mainTopInset =
    shellHeaderHidden === "" || isMyDay
      ? ""
      : barThroughTablet
        ? "max-lg:pt-[env(safe-area-inset-top)]"
        : "max-md:pt-[env(safe-area-inset-top)]";
  // Sign out lives in the tab bar's More sheet wherever the tab bar reaches, so
  // the header avatar hides over exactly the same range. This was hardcoded
  // `max-md:hidden` while the bar itself was already following the hook, which
  // put the avatar in the header AND Sign out in the sheet together from 768 to
  // 1023px — the duplication the tier was introduced to remove.
  //
  // A separate constant from `myDayHeaderHidden` on purpose, even though the
  // two spell the same thing today: that one answers "does My Day get the shell
  // header at all", this one answers "is Sign out already in the sheet". They
  // agree because both follow the bar's reach, not because they are the same
  // question, and collapsing them would hide that.
  const accountMenuHidden = barThroughTablet ? "max-lg:hidden" : "max-md:hidden";
  // "Hidden exactly where the tab bar reaches", for the sidebar toggle. Same
  // spelling as the two above and a third constant for the same reason they
  // are two: this one answers "is there already a menu at the bottom of this
  // screen", which is a different question that happens to have the same
  // answer. Literal strings, because Tailwind cannot see an assembled one.
  const phoneOnlyHidden = barThroughTablet ? "max-lg:hidden" : "max-md:hidden";
  // Scope the tenant brand color to the internal staff app only. Platform-admin
  // routes and the sign-in page live outside this shell and stay HoundStack-branded.
  const brandStyle = brand
    ? ({
        // Primary buttons pick up the tenant brand.
        "--primary": brand.hex,
        "--primary-foreground": brand.fg,
        // Sidebar active-nav highlight — soft brand tint with brand-colored text.
        "--sidebar-accent": brand.soft,
        "--sidebar-accent-foreground": brand.hex,
        // Available for the sidebar logo mark and any future accent spot.
        "--brand-accent": brand.hex,
        "--brand-accent-foreground": brand.fg,
      } as React.CSSProperties)
    : undefined;

  // NP-12: a locked account gets the notice and Plan & billing, nothing else.
  const { lock } = Route.useRouteContext();
  if (lock?.locked) {
    return (
      <>
        <AccountLockedShell
          reason={lock.reason}
          canChoosePlan={lock.canChoosePlan}
          onSignOut={handleSignOut}
          style={brandStyle}
        >
          <Outlet />
        </AccountLockedShell>
        {signOutDialog}
      </>
    );
  }

  return (
    <SidebarProvider docksFrom={docksFrom}>
      <div className="flex min-h-screen w-full bg-background" style={brandStyle}>
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            // Holds still while the page beneath it slides (styles.css, PAGE
            // TRANSITIONS). Named only during a transition.
            data-vt="header"
            // NATIVE ONLY — extends the bar under the status bar and pads its
            // contents clear of it. `h-14` alone put the search box and the
            // bell underneath the clock as soon as the page scrolled.
            style={nativeTopBarStyle(3.5)}
            // px-4 carries the landscape safe-area inset as well as its own
            // 1rem. calc, not a bare env(): the inset is 0 in portrait and on
            // the web, and a substitution would leave the bar with no padding
            // at all there — which is exactly what an inline paddingLeft did
            // before this, moving the sidebar toggle to x=0.
            className={`sticky top-[var(--hs-banner-h,0px)] z-30 flex h-14 items-center gap-2 border-b bg-card/80 pl-[calc(1rem+env(safe-area-inset-left))] pr-[calc(1rem+env(safe-area-inset-right))] backdrop-blur ${
              shellHeaderHidden
            }`}
          >
            {/* 28px (`h-7 w-7` from ui/sidebar.tsx) until 2026-08-19, when the
                browser sweep measured it. platform.tsx had already passed this
                exact override; the tenant shell — the one on every page a
                customer's staff actually use — had not. Same className rather
                than a new spelling, so the two shells cannot drift again.
                min-h/min-w rather than h/w: ui/input.tsx's note applies, a
                minimum wins over a height whatever order the utilities land
                in, and `size="icon"` sets one. */}
            {/* ── ONE MENU ON A PHONE, NOT TWO ────────────────────────────
                Below the tab-bar breakpoint this button and MobileTabBar's
                "More" opened two different sheets listing the same
                destinations — More is built from every nav item the tabs do
                not already show, which is exactly the sidebar's contents. Two
                buttons, in two corners, to the same places.

                So the phone gets whichever one the person chose, and from md
                (or lg) up this stays regardless: there the sidebar is docked
                and this toggle COLLAPSES it, which is a different job from
                opening a sheet. */}
            <SidebarTrigger
              className={`min-h-11 min-w-11 ${
                headerPrefs.phoneNav === "bottom" ? phoneOnlyHidden : ""
              }`}
            />
            <button
              type="button"
              onClick={openPalette}
              // 34.0px measured at 360px, from `py-1.5` around a 20px line —
              // the widest control in the header and, on a phone, the one most
              // likely to be aimed at with a thumb. `min-h-11` rather than more
              // padding: padding carrying the size is exactly what put the Help
              // link and the bell under the floor before them, and a minimum
              // survives a later text-size change.
              className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md border bg-background/60 px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">Search or jump to…</span>
              <kbd className="ml-auto hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-3xs sm:inline-block">
                {isMac ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
            {/* OPTIONAL, per person — see src/lib/header-prefs.ts. At 360px
                these five 44px boxes take 220px of a 360px bar and squeeze
                the search field, which is the control people actually use.
                Hidden here is still reachable: the Knowledge Center is in the
                More sheet and the command palette, and the weather is on the
                dashboard. */}
            {/* And not at all for a technician -- see headerControlsForRole. */}
            {roleControls.help && headerPrefs.showHelp && (
              <Link
                to="/help"
                search={{ article: undefined }}
                aria-label="Knowledge Center"
                // A 16px glyph centred in a 44px box, the shape ui/dialog.tsx and
                // ui/sheet.tsx already use. Padding was carrying the size — `p-2`
                // made a 32px target, and `touch:p-2.5` around a 20px glyph got
                // it to 40, still under the minimum on the widths where it is
                // actually thumbed. The glyph is untouched, so the header looks
                // the same; only the part a thumb can miss changed. `shrink-0`
                // because the search button beside it is `flex-1` and would
                // otherwise squeeze this back below 44 at 360px.
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <HelpCircle className="h-4 w-4 max-md:h-5 max-md:w-5 shrink-0" />
              </Link>
            )}
            {roleControls.weather && headerPrefs.showWeather && <WeatherPopover />}
            {/* Auto-routing running in the background, or finished and not
                yet looked at. Renders nothing otherwise. */}
            <RoutingRunIndicator />
            <NotificationBell />
            {/* Wherever the tab bar reaches, this lives in its More sheet —
                the most dangerous action doesn't belong in a phone header.
                It was a bare "Sign out" button, which made the header's only
                trace of the signed-in person a one-click way to leave. The
                avatar answers "which account am I in" and puts Sign out one
                level down. */}
            <div className={accountMenuHidden}>
              <AccountMenu onSignOut={handleSignOut} />
            </div>
          </header>
          <SuspensionBanner />
          {/* BUILD-7: after suspension (which actually blocks) and before
              announcements (which are optional reading). A trial countdown is
              information, not an obstacle — it sits in the flow rather than in
              front of it. */}
          <TrialBanner />
          <AnnouncementBanner />
          {/* The guided setup, off its own page. In the flow, never over it:
              see SetupGuideBanner for the overlay this replaced. */}
          <SetupGuideBanner />
          {/* The bottom padding clears the fixed tab bar for exactly as long
              as the bar is on screen — which now depends on the role, not only
              the width (Q-2). Both read useTabletTier so they cannot disagree:
              a mismatch puts the bar on top of My Day's Complete button. */}
          {/* A status-bar backdrop wherever the shell hides its header.
              Without the header nothing paints behind the clock, so on Waste
              log, Alerts and Settings a scrolled page slid under the time and
              the Dynamic Island ("Behavior on rou..." drawn behind them,
              iPhone 17 Pro sim, 2026-09-27). My Day never showed it because its
              own sticky bar paints that strip; this gives every other page the
              same strip. Native only and inline-styled, per native-build.ts:
              on the web the inset is 0 and this is not in the bundle at all.
              Visible exactly where the header is hidden, never beside it. */}
          {IS_NATIVE_BUNDLE && shellHeaderHidden !== "" && (
            <div
              aria-hidden
              className={`pointer-events-none fixed inset-x-0 top-0 z-30 bg-background/80 backdrop-blur ${
                barThroughTablet ? "lg:hidden" : "md:hidden"
              }`}
              style={{ height: "env(safe-area-inset-top)" }}
            />
          )}
          <main
            // Horizontal padding, top padding and the content column are
            // PageShell's — see src/components/PageShell.tsx, which says why
            // they are decided in one place. What stays here is chrome:
            // the native status-bar inset where the shell header is hidden,
            // and the reservation for the tab bar at the bottom.
            className={`min-w-0 flex-1 ${mainTopInset} ${
              // mainBottomPadding reserves the height of the tab bar. With the
              // bar switched off that reservation is just dead space at the
              // bottom of every page, so this falls back to the home-indicator
              // inset alone.
              headerPrefs.phoneNav === "bottom"
                ? mainBottomPadding
                : "pb-[calc(2rem+env(safe-area-inset-bottom))]"
            }`}
          >
            <PageShell width={pageWidth}>
              <Outlet />
            </PageShell>
          </main>
        </div>
        {headerPrefs.phoneNav === "bottom" && <MobileTabBar />}
        {/* The one time-clock sheet, opened from the More sheet and the
            sidebar (src/components/TimeClock.tsx). */}
        <TimeClockSheetHost />
        {/* The route on the iPhone lock screen, from whatever page is open:
            it comes back by itself when the app does. Nothing off iOS. */}
        <RouteLockScreenHost />
        <CommandPalette />
        <KeyboardShortcuts />
        <InstallBanner />
        <RoleGuard />
        {signOutDialog}
      </div>
    </SidebarProvider>
  );
}
