import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import { useEffect } from "react";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import {
  clearPersistedReadCaches,
  ensureReadCachePersistence,
  readLastUser,
} from "@/lib/offline/read-cache";
import { useOfflineSignOut } from "@/hooks/useOfflineSignOut";
import { isOfflineAuthFailure } from "@/lib/offline/read-cache-policy";
import { getMyOrg } from "@/lib/org.functions";
import { getPlatformContext } from "@/lib/platform.functions";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { OnboardingTour } from "@/components/OnboardingTour";
import { InstallBanner } from "@/components/InstallBanner";
import { AppSidebar } from "@/components/AppSidebar";
import { AccountMenu } from "@/components/AccountMenu";
import { TrialBanner } from "@/components/TrialBanner";
import { MobileTabBar } from "@/components/MobileTabBar";
import { useTabletTier } from "@/hooks/useTabletTier";
import { RoleGuard } from "@/components/RoleGuard";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationBell } from "@/components/NotificationBell";
import { WeatherPopover } from "@/components/WeatherPopover";
import { AnnouncementBanner } from "@/components/AnnouncementBanner";
import { SuspensionBanner } from "@/components/SuspensionBanner";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { HelpCircle, Search } from "lucide-react";
import { useBrandAccent } from "@/hooks/useBrandAccent";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async ({ context }) => {
    const online = typeof navigator === "undefined" || navigator.onLine !== false;
    const identity = await resolveIdentity(online);
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
      throw redirect({ to: isPlatformAdmin ? "/platform" : "/no-workspace" });
    }

    return { userId: identity.userId, user: identity.user, organization: org.organization };
  },
  component: AppShell,
});

/**
 * Who is signed in, tolerating a dead connection.
 *
 * supabase.auth.getUser() is a NETWORK call, so offline it fails and the old
 * code read that as "not signed in" and redirected to /auth — the app's entire
 * offline story died here, before any cache could be consulted. The fallbacks
 * only ever apply when the failure looks like a lost network (never a 4xx from
 * the auth server), and they grant nothing but a read of data already on this
 * device; every server call still needs a real token.
 */
type IdentityResult =
  | { ok: true; userId: string; user: User | null }
  /** `rejected` distinguishes "the server said no" from "we could not ask".
   *  Only the first should wipe the device — wiping on the second would delete
   *  the tech's day every time they open the app in a dead zone, which is the
   *  case this whole feature exists for. */
  | { ok: false; rejected: boolean };

async function resolveIdentity(online: boolean): Promise<IdentityResult> {
  let authError: unknown = null;
  try {
    const { data, error } = await supabase.auth.getUser();
    if (data?.user) return { ok: true, userId: data.user.id, user: data.user };
    authError = error;
  } catch (e) {
    authError = e;
  }
  // Not a transport failure: the server answered, and the answer was no.
  if (!isOfflineAuthFailure(authError, { online })) return { ok: false, rejected: true };

  // Local read of the persisted session — no network, still authoritative
  // about which account this device belongs to.
  try {
    const { data } = await supabase.auth.getSession();
    if (data.session?.user) {
      return { ok: true, userId: data.session.user.id, user: data.session.user };
    }
  } catch {
    /* fall through to the pointer below */
  }

  // The access token expired overnight and cannot be refreshed without a
  // network: exactly the 7am-in-a-dead-zone case this feature exists for.
  // The pointer is written only on a verified sign-in and deleted on sign-out,
  // so it can only name a user whose session is still on this device.
  const lastUser = readLastUser();
  return lastUser
    ? { ok: true, userId: lastUser, user: null }
    : { ok: false, rejected: false };
}

function openPalette() {
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
}

function AppShell() {
  const router = useRouter();
  const { signOut, dialog: signOutDialog } = useOfflineSignOut();

  // Native Capacitor bootstrap — theme-coherent status bar; no-ops on web.
  // Also registers APNs/FCM device tokens with our backend and routes push
  // notification taps to the deep link in the payload (e.g. /my-day?date=…).
  useEffect(() => {
    let cancelled = false;
    let removeDeepLinks: (() => void) | undefined;
    (async () => {
      try {
        const native = await import("@/lib/native");
        await native.initStatusBar();
        if (!native.isNative()) return;
        removeDeepLinks = await native.initPushDeepLinks((path) => {
          if (!cancelled) router.history.push(path);
        });
        const { subscribeStaffNativePush } = await import("@/lib/push.functions");
        await native.registerPushNotifications(async (token) => {
          if (cancelled) return;
          try {
            await subscribeStaffNativePush({
              data: {
                token,
                platform: native.platform() === "ios" ? "ios" : "android",
                userAgent: navigator.userAgent,
              },
            });
          } catch (e) {
            console.warn("native push register failed", e);
          }
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      removeDeepLinks?.();
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
  const isMyDay = pathname === "/my-day" || pathname.startsWith("/my-day/");

  const brand = useBrandAccent();
  // Q-2's tablet tier: the tab bar's reach, this padding, and the header above
  // are one decision, so they all read it from here rather than each writing a
  // breakpoint of their own. Both class strings are spelled out in full —
  // Tailwind scans source for literal class names and cannot see an assembled
  // one.
  const { mainBottomPadding, barThroughTablet } = useTabletTier();
  const myDayHeaderHidden = barThroughTablet ? "max-lg:hidden" : "max-md:hidden";
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

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background" style={brandStyle}>
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header
            className={`sticky top-[var(--hs-banner-h,0px)] z-30 flex h-14 items-center gap-2 border-b bg-card/80 px-4 backdrop-blur ${
              isMyDay ? myDayHeaderHidden : ""
            }`}
          >
            <SidebarTrigger />
            <button
              type="button"
              onClick={openPalette}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background/60 px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">Search or jump to…</span>
              <kbd className="ml-auto hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-3xs sm:inline-block">
                {isMac ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
            <Link
              to="/help"
              search={{ article: undefined }}
              aria-label="Knowledge Center"
              // A 16px glyph centred in a 44px box, the shape ui/dialog.tsx and
              // ui/sheet.tsx already use. Padding was carrying the size — `p-2`
              // made a 32px target, and `max-md:p-2.5` around a 20px glyph got
              // it to 40, still under the minimum on the widths where it is
              // actually thumbed. The glyph is untouched, so the header looks
              // the same; only the part a thumb can miss changed. `shrink-0`
              // because the search button beside it is `flex-1` and would
              // otherwise squeeze this back below 44 at 360px.
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <HelpCircle className="h-4 w-4 max-md:h-5 max-md:w-5" />
            </Link>
            <WeatherPopover />
            <NotificationBell />
            {/* Below `md` this lives in the tab bar's More sheet — the most
                dangerous action doesn't belong in a phone header.
                It was a bare "Sign out" button, which made the header's only
                trace of the signed-in person a one-click way to leave. The
                avatar answers "which account am I in" and puts Sign out one
                level down. */}
            <div className="max-md:hidden">
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
          {/* The bottom padding clears the fixed tab bar for exactly as long
              as the bar is on screen — which now depends on the role, not only
              the width (Q-2). Both read useTabletTier so they cannot disagree:
              a mismatch puts the bar on top of My Day's Complete button. */}
          {/* Content width and rhythm for EVERY authenticated page.
              1200px was a reading measure applied to an operations tool. On a
              1920px display it left ~700px of empty gutter beside a dispatch
              board and a map that were both fighting for room, and the same
              waste showed on every table in the app.
              1600 rather than none: past that, a table row makes the eye track
              so far from the row label to the last column that it loses its
              place. Wide, with a limit. Top padding tightens too — a page that
              starts an inch down the screen wastes the most valuable band on
              it. */}
          <main
            className={`min-w-0 flex-1 px-4 pt-4 sm:px-6 sm:pt-5 ${mainBottomPadding}`}
          >
            <div className="mx-auto w-full max-w-[1600px]">
              <Outlet />
            </div>
          </main>
        </div>
        <MobileTabBar />
        <CommandPalette />
        <KeyboardShortcuts />
        <OnboardingTour />
        <InstallBanner />
        <RoleGuard />
        {signOutDialog}
      </div>
    </SidebarProvider>
  );
}
