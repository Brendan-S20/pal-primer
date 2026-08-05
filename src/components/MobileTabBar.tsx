import { useState } from "react";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  Bell,
  CalendarDays,
  HelpCircle,
  LayoutDashboard,
  LogOut,
  Menu,
  Plus,
  Sun,
  Users,
} from "lucide-react";
import { useOfflineSignOut } from "@/hooks/useOfflineSignOut";
import { canAccess, useMyRole } from "@/hooks/useMyRole";
import { useTabletTier } from "@/hooks/useTabletTier";
import { NAV_GROUPS, type NavItem } from "@/components/AppSidebar";
import { CreateSheet } from "@/components/CreateSheet";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { UserAvatar } from "@/components/UserAvatar";
import { useMyProfile } from "@/hooks/useMyProfile";

/**
 * Fired by the tech "Schedule" tab so My Day scrolls to / focuses its
 * seven-day strip (Phase 2 — replaces the Phase 1 date-picker stand-in).
 * My Day listens for this.
 */
export const FOCUS_MY_DAY_SCHEDULE_EVENT = "houndstack:focus-my-day-schedule";

function todayISO() {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

// Destinations already surfaced as a first-class tab — excluded from "More".
const OFFICE_TAB_URLS = ["/dashboard", "/routes", "/clients"];
const TECH_TAB_URLS = ["/my-day"];

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
  const search = useRouterState({ select: (r) => r.location.search }) as { date?: string };
  const [createOpen, setCreateOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  // Above the `!role` early return: hooks cannot be conditional.
  const { signOut, dialog: signOutDialog } = useOfflineSignOut();
  const { staff: me } = useMyProfile();

  // No role yet (loading, or a platform admin without a tenant org): no bar.
  if (!role) return null;

  const isTech = role === "tech";
  const isActive = (url: string) =>
    url === "/dashboard"
      ? pathname === "/dashboard"
      : pathname === url || pathname.startsWith(url + "/");

  const tabUrls = isTech ? TECH_TAB_URLS : OFFICE_TAB_URLS;
  const moreGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => canAccess(role, it.url) && !tabUrls.includes(it.url)),
  })).filter((g) => g.items.length > 0);

  const handleSignOut = async () => {
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
  const viewingOtherDay = !!search.date && search.date !== todayISO();

  const moreButton = (
    <button type="button" onClick={() => setMoreOpen(true)} className={tabClass(moreOpen)}>
      <Menu className="h-5 w-5" />
      <span>More</span>
    </button>
  );

  return (
    <>
      <nav
        aria-label="Primary"
        className={`fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80 ${barHiddenFrom}`}
      >
        {isTech ? (
          <ul className="grid grid-cols-3">
            <li>
              <Link to="/my-day" preload="render" className={tabClass(onMyDay && !viewingOtherDay)}>
                <Sun className="h-5 w-5" />
                <span>Today</span>
              </Link>
            </li>
            <li>
              <button
                type="button"
                onClick={focusMyDaySchedule}
                className={tabClass(onMyDay && viewingOtherDay)}
              >
                <CalendarDays className="h-5 w-5" />
                <span>Schedule</span>
              </button>
            </li>
            <li>{moreButton}</li>
          </ul>
        ) : (
          <ul className="grid grid-cols-5">
            <li>
              <Link to="/dashboard" preload="render" className={tabClass(isActive("/dashboard"))}>
                <LayoutDashboard className="h-5 w-5" />
                <span>Home</span>
              </Link>
            </li>
            <li>
              <Link to="/routes" preload="render" className={tabClass(isActive("/routes"))}>
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
              <Link to="/clients" preload="render" className={tabClass(isActive("/clients"))}>
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
                <li>
                  <Link
                    to="/notifications"
                    onClick={() => setMoreOpen(false)}
                    className="flex min-h-11 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors hover:bg-muted active:bg-muted"
                  >
                    <Bell className="h-4 w-4 shrink-0 text-muted-foreground" />
                    Notifications
                  </Link>
                </li>
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
    </>
  );
}
