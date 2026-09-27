import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listMyNotifications } from "@/lib/notifications-center.functions";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  CalendarDays,
  Trash2,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Sun,
  Users,
} from "lucide-react";
import { useOfflineSignOut } from "@/hooks/useOfflineSignOut";
import { useMyRole } from "@/hooks/useMyRole";
import { useTabletTier } from "@/hooks/useTabletTier";
import {
  NAV_GROUPS,
  isNavItemVisible,
  useNavVisibility,
  type NavItem,
} from "@/components/AppSidebar";
import { CreateSheet } from "@/components/CreateSheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UserAvatar } from "@/components/UserAvatar";
import { useMyProfile } from "@/hooks/useMyProfile";
import { useConfirmDialog } from "@/components/ConfirmDialog";

/**
 * Asks My Day to scroll to and focus its seven-day strip. My Day listens.
 *
 * Fired by pressing the "Today" tab while already on My Day — the press that
 * would otherwise do nothing. It used to belong to a "Schedule" tab that
 * navigated nowhere and existed only to send this event; that tab is gone and
 * a real destination took its place.
 */
export const FOCUS_MY_DAY_SCHEDULE_EVENT = "houndstack:focus-my-day-schedule";

// Destinations already surfaced as a first-class tab — excluded from "More".
const OFFICE_TAB_URLS = ["/dashboard", "/routes", "/clients"];
const TECH_TAB_URLS = ["/my-day", "/waste-log", "/notifications"];

const tabClass = (active: boolean) =>
  `flex min-h-12 w-full flex-col items-center justify-center gap-0.5 px-1 pb-1.5 pt-2 text-3xs font-medium transition-colors ${
    active ? "text-primary" : "text-muted-foreground hover:text-foreground"
  }`;

/**
 * Mobile bottom-tab nav for the staff app, modeled on the portal's BottomTabs
 * (safe-area padding, blurred bar, preload="render" to kill dead-clicks).
 * Rendered ONLY below `md` — the desktop sidebar shell is untouched.
 */
export function MobileTabBar() {
  const { role } = useMyRole();
  // Q-2's tablet tier. A tech on a crew tablet keeps this bar through
  // 768–1024px; an office user does not, because the dispatch board renders
  // there and a bottom bar would sit on top of it. See useTabletTier.
  const { barHiddenFrom } = useTabletTier();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const [createOpen, setCreateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Above the `!role` early return: hooks cannot be conditional.
  const { signOut, dialog: signOutDialog } = useOfflineSignOut();
  const { confirm: confirmSignOut, dialog: confirmSignOutDialog } = useConfirmDialog();
  const { staff: me } = useMyProfile();
  // Also above the early return, and for the same reason.
  const navVisibility = useNavVisibility();
  // Unread badge on the Alerts tab. `staleTime` keeps it off the wire on every
  // tab change; `retry: false` keeps a van with no signal from queueing
  // retries behind a bar that is only decoration when it fails.
  const notificationsFn = useServerFn(listMyNotifications);
  const { data: notifications } = useQuery({
    queryKey: ["my-notifications", "tab-badge"],
    queryFn: () => notificationsFn(),
    staleTime: 60_000,
    retry: false,
  });
  const unread = notifications?.unread ?? 0;

  // No role yet (loading, or a platform admin without a tenant org): no bar.
  if (!role) return null;

  const isTech = role === "tech";
  const isActive = (url: string) =>
    url === "/dashboard"
      ? pathname === "/dashboard"
      : pathname === url || pathname.startsWith(url + "/");

  const tabUrls = isTech ? TECH_TAB_URLS : OFFICE_TAB_URLS;
  // `isNavItemVisible` rather than a bare `canAccess`: this sheet used to apply
  // only the permission filter, so every flag the sidebar honoured leaked here.
  // DNA compliance has been showing to residential-only orgs on phones because
  // of it. See the note on NavVisibility in AppSidebar.
  const moreGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter(
      (it) => isNavItemVisible(it, role, navVisibility) && !tabUrls.includes(it.url),
    ),
  })).filter((g) => g.items.length > 0);

  const handleSignOut = async () => {
    // Ask first. The sheet slides up from the bar, and its last row lands
    // exactly where the More tab sits underneath it: measured in the iOS
    // simulator, a second tap on More while the sheet was still animating
    // hit Sign out and ended the session. Signing out also wipes this
    // device's saved day, so an accidental one costs a tech their route and
    // their password mid-shift. The unsynced-work prompt below only fires
    // when there IS unsynced work; this one always does.
    const sure = await confirmSignOut({
      title: "Sign out?",
      description:
        "Today's route is cleared from this device. You'll need your password to sign back in.",
      confirmLabel: "Sign out",
      cancelLabel: "Stay signed in",
    });
    if (!sure) return;
    // Wipes this device's persisted day along with the session: the next tech
    // to unlock a shared tablet must not inherit the previous one's route, or
    // their queued jobs, or their photos of customers' yards. Anything still
    // unsynced is pushed first and only discarded with a yes — which is also
    // why the redirect is conditional. Saying "stay signed in" and being signed
    // out anyway would be the worst of both.
    if (await signOut()) window.location.href = "/auth";
  };

  const focusMyDaySchedule = () => {
    const fire = () => window.dispatchEvent(new Event(FOCUS_MY_DAY_SCHEDULE_EVENT));
    if (pathname.startsWith("/my-day")) {
      fire();
    } else {
      navigate({ to: "/my-day" });
      // Let the route mount before asking it to focus the day strip.
      setTimeout(fire, 250);
    }
  };

  const onMyDay = pathname === "/my-day" || pathname.startsWith("/my-day/");

  const moreButton = (
    // data-tour: the guided tour anchors to these. They were only ever on
    // AppSidebar items, which are hidden below `md` — so on a phone every tour
    // step fell back to a centred card over a dimmed screen and taught nobody
    // where anything lives. "more" is also the fallback anchor for sections
    // that have no tab of their own (Zones, Invoices, Settings).
    <button
      type="button"
      data-tour="more"
      onClick={() => setMoreOpen(true)}
      className={tabClass(moreOpen)}
    >
      <Menu className="h-5 w-5" />
      <span>More</span>
    </button>
  );

  return (
    <>
      <nav
        aria-label="Primary"
        // Marks this as one of the bars pinned to the bottom of the screen.
        // My Day's map measures the gap between its own top edge and the
        // highest of these, so a full-height map stops above the navigation
        // instead of behind it. Nothing else reads the attribute.
        data-bottom-chrome=""
        className={`fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80 ${barHiddenFrom}`}
      >
        {isTech ? (
          /* FOUR TABS, THREE OF THEM DESTINATIONS.
             It was Today / Schedule / More, and "Schedule" went nowhere: it
             fired FOCUS_MY_DAY_SCHEDULE_EVENT to scroll the seven-day strip
             that is already on screen, on the page the tech was already on. So
             a technician's entire bottom bar offered one destination and a
             sheet, while /waste-log and /notifications — both things they can
             actually open, and both things they need mid-route — were buried
             two taps deep in More.
             The day strip keeps doing the job the Schedule tab pretended to
             do, which is why dropping the tab costs nothing. */
          <ul className="grid grid-cols-4">
            <li>
              <Link
                to="/my-day"
                data-tour="/my-day"
                preload="render"
                className={tabClass(onMyDay)}
                // Pressing the tab you are already on jumps to the day strip.
                // That is where FOCUS_MY_DAY_SCHEDULE_EVENT lives now: the
                // Schedule tab that used to fire it was a tab that navigated
                // nowhere, and this is the same affordance attached to the
                // gesture people already use for it.
                onClick={() => {
                  if (onMyDay) focusMyDaySchedule();
                }}
              >
                <Sun className="h-5 w-5" />
                <span>Today</span>
              </Link>
            </li>
            <li>
              <Link
                to="/waste-log"
                data-tour="/waste-log"
                preload="render"
                className={tabClass(isActive("/waste-log"))}
              >
                <Trash2 className="h-5 w-5" />
                <span>Waste log</span>
              </Link>
            </li>
            <li>
              <Link
                to="/notifications"
                data-tour="/notifications"
                preload="render"
                className={`relative ${tabClass(isActive("/notifications"))}`}
              >
                <span className="relative">
                  <Bell className="h-5 w-5" />
                  {unread > 0 && (
                    // Count, not a dot: "three things happened" and "something
                    // happened" are different messages to somebody deciding
                    // whether to stop driving and look.
                    <span
                      className="absolute -right-2 -top-1 min-w-4 rounded-full bg-destructive px-1 text-center text-3xs font-bold leading-4 text-destructive-foreground"
                      aria-hidden="true"
                    >
                      {unread > 9 ? "9+" : unread}
                    </span>
                  )}
                </span>
                <span>Alerts</span>
                {unread > 0 && <span className="sr-only">{unread} unread</span>}
              </Link>
            </li>
            <li>{moreButton}</li>
          </ul>
        ) : (
          <ul className="grid grid-cols-5">
            <li>
              <Link
                to="/dashboard"
                data-tour="/dashboard"
                preload="render"
                className={tabClass(isActive("/dashboard"))}
              >
                <LayoutDashboard className="h-5 w-5" />
                <span>Home</span>
              </Link>
            </li>
            <li>
              <Link
                to="/routes"
                data-tour="/routes"
                preload="render"
                className={tabClass(isActive("/routes"))}
              >
                <CalendarDays className="h-5 w-5" />
                <span>Schedule</span>
              </Link>
            </li>
            <li>
              <button
                type="button"
                aria-label="Create"
                onClick={() => setCreateOpen(true)}
                className={tabClass(createOpen)}
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-md">
                  <Plus className="h-5 w-5" />
                </span>
              </button>
            </li>
            <li>
              <Link
                to="/clients"
                data-tour="/clients"
                preload="render"
                className={tabClass(isActive("/clients"))}
              >
                <Users className="h-5 w-5" />
                <span>Clients</span>
              </Link>
            </li>
            <li>{moreButton}</li>
          </ul>
        )}
      </nav>

      {!isTech && <CreateSheet open={createOpen} onOpenChange={setCreateOpen} />}

      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent
          side="bottom"
          className={`max-h-[80dvh] overflow-y-auto rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)] ${barHiddenFrom}`}
        >
          <SheetHeader className="border-b px-4 py-3 text-left">
            <SheetTitle className="text-base">More</SheetTitle>
          </SheetHeader>
          {/* Your account, at the top rather than buried above Sign out. On a
              phone this sheet is the ONLY place the signed-in identity appears
              — the header is hidden on My Day and carries no avatar anywhere
              else — so "which account am I in" has to be answerable here. */}
          <Link
            to="/profile"
            onClick={() => setMoreOpen(false)}
            className="flex min-h-14 items-center gap-3 border-b px-4 text-sm transition-colors hover:bg-muted active:bg-muted"
          >
            <UserAvatar
              name={me?.display_name}
              avatarPath={me?.avatar_url}
              seed={me?.id}
              className="h-9 w-9"
            />
            <span className="min-w-0">
              <span className="block truncate font-medium">
                {me?.display_name ?? "Your account"}
              </span>
              <span className="block truncate text-xs text-muted-foreground">
                View and edit your account
              </span>
            </span>
          </Link>
          <nav aria-label="All sections" className="p-2">
            {moreGroups.map((group) => (
              <div key={group.label} className="py-1">
                <div className="px-3 pb-1 pt-2 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </div>
                <ul>
                  {group.items.map((item: NavItem) => (
                    <li key={item.url}>
                      <Link
                        to={item.url}
                        onClick={() => setMoreOpen(false)}
                        className={`flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-muted active:bg-muted ${
                          isActive(item.url) ? "text-primary" : ""
                        }`}
                      >
                        <item.icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                        {item.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <div className="mt-1 border-t py-1">
              <ul>
                {/* Techs reach this from the Alerts tab, where it carries an
                    unread badge. Listing it twice would put the same
                    destination on the bar and two taps inside a sheet. Office
                    roles have no Alerts tab, so for them it stays here. */}
                {!isTech && (
                  <li>
                    <Link
                      to="/notifications"
                      onClick={() => setMoreOpen(false)}
                      className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-muted active:bg-muted"
                    >
                      <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
                      {/* The page this opens is titled Alerts, like the tech
                          tab; a link that names its destination differently
                          from the destination's own heading reads as two places. */}
                      Alerts
                    </Link>
                  </li>
                )}
                <li>
                  <Link
                    to="/help"
                    search={{ article: undefined }}
                    onClick={() => setMoreOpen(false)}
                    className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-muted active:bg-muted"
                  >
                    <HelpCircle className="h-4 w-4 shrink-0 text-muted-foreground" />
                    Help
                  </Link>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-left text-sm font-medium transition-colors hover:bg-muted active:bg-muted"
                  >
                    <LogOut className="h-4 w-4 shrink-0 text-muted-foreground" />
                    Sign out
                  </button>
                </li>
              </ul>
            </div>
          </nav>
        </SheetContent>
      </Sheet>
      {signOutDialog}
      {confirmSignOutDialog}
    </>
  );
}
