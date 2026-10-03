import { useEffect } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMyRole, canAccess, type AppRole } from "@/hooks/useMyRole";
import { getPlatformContext } from "@/lib/platform.functions";
import { getFranchiseContext } from "@/lib/franchise.functions";
import { getReviewQueueCount } from "@/lib/review-queue.functions";
import {
  LayoutDashboard,
  Users,
  MapPin,
  Route as RouteIcon,
  Truck,
  CalendarDays,
  Trash2,
  MessageSquare,
  MessageCircleWarning,
  Receipt,
  BarChart3,
  Scale,
  CreditCard,
  Upload,
  Settings as SettingsIcon,
  UserPlus,
  Building2,
  Package,
  Timer,
  ReceiptText,
  Shield,
  Dna,
  ClipboardCheck,
  Inbox as InboxIcon,
  ShieldAlert,
  FileSignature,
} from "lucide-react";
import { Megaphone } from "lucide-react";
import { REPORT_PATHS } from "@/components/ReportsNav";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { dirFor } from "@/lib/i18n";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { APP_NAME } from "@/lib/scoop";
import { Logo } from "@/components/Logo";
import { UserAvatar } from "@/components/UserAvatar";
import { useMyProfile } from "@/hooks/useMyProfile";
import { useCommercialAccounts } from "@/components/CommercialOnly";

export type NavItem = {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Only meaningful for an org that serves HOAs, apartment complexes or dog
   *  parks. Hidden when the owner has said they do not — see CommercialOnly. */
  commercialOnly?: boolean;
  /** Only meaningful for a franchise PARENT — an org with `is_franchise_parent`
   *  set, or with children linked to it. For everyone else the screen behind it
   *  is a page about locations they do not have. Unlike `commercialOnly` this
   *  fails CLOSED while the answer is unknown: see `useNavVisibility`. */
  franchiseParentOnly?: boolean;
  /** Other pages this entry stands for, so it stays highlighted there. Reports
   *  is one entry for three pages (see components/ReportsNav). */
  alsoActiveOn?: readonly string[];
};

// Single source of nav truth — also consumed by MobileTabBar's "More" sheet so
// the phone nav can never drift from (or exceed) what the sidebar offers.
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      // Everything waiting on the office in one list: texts to answer,
      // concerns, needs-review records, disputes and unread alerts, each
      // linking to the page where it is done (launch pass, 2026-10). Second,
      // because it is the evening round's first stop.
      { title: "Inbox", url: "/inbox", icon: InboxIcon },
      { title: "Leads", url: "/leads", icon: UserPlus },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Clients", url: "/clients", icon: Users },
      { title: "Campaigns", url: "/campaigns", icon: Megaphone },
      { title: "Zones", url: "/zones", icon: MapPin },
      // "Schedule", not "Routes": there is no `routes` table — a route is
      // visits filtered by a day and a tech — and MobileTabBar already called
      // this Schedule, so desktop and phone were naming the same screen two
      // different things. Label only; the URL stays /routes because moving it
      // would touch the dispatcher landing redirect, the onboarding tour
      // anchors and the nightly push deep-links, to change a string no
      // customer ever reads.
      { title: "Schedule", url: "/routes", icon: RouteIcon },
      // Messages and Concerns were under Field until the launch pass
      // (2026-10). Neither is a field screen: both are the office answering
      // customers, and neither is open to a technician (ROUTE_ROLES gives
      // both to owner, office manager and dispatcher only), so for the one
      // role Field exists for they were never in it at all.
      { title: "Messages", url: "/messages", icon: MessageSquare },
      { title: "Concerns", url: "/concerns", icon: MessageCircleWarning },
      // Inventory and Timesheets were a sixth group called "Ops", two groups
      // below one called "Operations" — the same word twice, once abbreviated,
      // in the sidebar and again in the phone's More sheet, which is built from
      // this list. Nobody could say which of the two a thing belonged in, so
      // they are one group.
      { title: "Inventory", url: "/inventory", icon: Package },
      // The time clock's office half. Here rather than under Field because
      // the people who open it are the owner and the office manager; the
      // techs' half is the card at the top of My day.
      { title: "Timesheets", url: "/timesheets", icon: Timer },
      { title: "Expenses", url: "/expenses", icon: ReceiptText },
    ],
  },
  {
    label: "Billing",
    items: [
      { title: "Invoices", url: "/invoices", icon: Receipt },
      { title: "Quotes", url: "/quotes", icon: FileSignature },
      { title: "Payments", url: "/payments", icon: CreditCard },
      // BUILD-13: the accountant's pack. In the nav rather than URL-only
      // because the whole point is that an owner finds it in January without
      // having to be told it exists.
      // Tax & accountant was here. It is a tab of Reports now (launch pass,
      // 2026-10): one place to look back at the business, and the sidebar
      // one entry shorter. /tax-reports still works.
      // BUILD-12: disputes get their own entry rather than living inside the
      // review queue. A chargeback has a deadline attached, and one buried
      // under visit-timestamp warnings is one nobody answers in time.
      { title: "Disputes", url: "/disputes", icon: ShieldAlert },
    ],
  },
  // Field comes AFTER Billing since the launch pass (2026-10). At 1280x800,
  // a 13-inch laptop, the sidebar showed Overview, Operations and Field and
  // cut off at DNA compliance, so Invoices and Quotes, which the owner opens
  // every evening, needed a scroll inside the sidebar to reach, while My day
  // and Waste log, which the owner rarely opens from a laptop, did not.
  // Technicians see only Field (plus Help), so its position changes nothing
  // for them.
  {
    label: "Field",
    items: [
      { title: "My day", url: "/my-day", icon: Truck },
      // Directly under My day, because it answers the question My day raises:
      // this is today, what about Thursday. Filtered by canAccess like every
      // other item, and the tab bar's More sheet is built from this list, so
      // adding it here is also how a technician on a phone reaches it.
      { title: "My schedule", url: "/my-schedule", icon: CalendarDays },
      { title: "Waste log", url: "/waste-log", icon: Trash2 },
      { title: "Neighbor canvassing", url: "/neighbors", icon: MapPin },
      // Commercial-only: /dna lists clients filtered to account_type
      // 'commercial', so for a residential-only business this entry opens a
      // permanently empty workspace. Hidden by commercialOnly below rather
      // than removed, because the orgs that do serve HOAs bill violation
      // fines from it.
      { title: "DNA compliance", url: "/dna", icon: Dna, commercialOnly: true },
    ],
  },
  {
    label: "Insights",
    items: [
      // One entry for Reports, Analytics and Tax & accountant, which are its
      // three tabs (components/ReportsNav). Highlighted on all three.
      { title: "Reports", url: "/reports", icon: BarChart3, alsoActiveOn: REPORT_PATHS },
      // BUILD-10: guardrail 10.5's review queue. In the nav rather than
      // URL-only on purpose — a queue of things we refused to guess about
      // is worthless if nobody knows it exists.
      { title: "Needs review", url: "/review", icon: ClipboardCheck },
      // In the nav rather than URL-only for the same reason as Needs review:
      // a report of who is off the rate card is worthless if the only person
      // who can find it is the one who already knew to look.
      { title: "Rate card drift", url: "/pricing-drift", icon: Scale },
      // ── WAS HIDDEN FROM EVERYONE; NOW SHOWN TO THE ORGS IT IS FOR ───────
      //
      // This entry was omitted entirely (per Brendan, 2026-07-14) "until
      // multi-location is a real, supported offering", leaving /franchise
      // reachable only by typing the URL. The cost of that landed on
      // 2026-08-30: the owner of the demo franchise parent signed in, found no
      // way to reach their own locations, and reasonably read it as the
      // locations being broken or unlinked. They were neither.
      //
      // Hiding it from everyone was the right call only for as long as nobody
      // had locations. `franchiseParentOnly` is the narrower version of the
      // same intent — an org with no children still never sees it, and the one
      // that has them can now find them. Title and icon match the page's own
      // h1 ("Royalties & rollup", Building2) so the nav and the screen do not
      // name the same thing two different ways.
      { title: "Royalties", url: "/franchise", icon: Building2, franchiseParentOnly: true },
    ],
  },
  {
    label: "Setup",
    items: [
      { title: "Import", url: "/imports", icon: Upload },
      { title: "Settings", url: "/settings", icon: SettingsIcon },
    ],
  },
];

/**
 * The answers every nav consumer needs before it can decide what to show.
 *
 * ── WHY THIS IS SHARED RATHER THAN WRITTEN TWICE ──────────────────────────
 *
 * NAV_GROUPS says it is the "single source of nav truth", consumed by
 * MobileTabBar's More sheet "so the phone nav can never drift from (or exceed)
 * what the sidebar offers". The list was shared; the FILTER was not. The
 * sidebar applied `commercialOnly` and the phone did not, so a residential-only
 * org has been seeing DNA compliance in More this whole time — the exact drift
 * the comment promises cannot happen.
 *
 * One item leaking was survivable. Adding a second flag with the same split
 * would have made it a pattern, so the filter moved here and both callers use
 * it. Neither is a security boundary: the routes and their server functions
 * keep their own gates, and `/franchise` is owner-only in ROUTE_ROLES.
 */
export type NavVisibility = { commercialEnabled: boolean; franchiseParent: boolean };

/** A nav entry's name in the interface language: `nav.item.<url without the
 *  slash>`, falling back to the English title above. Keyed by URL rather than
 *  by title because the URL is what stays put when an entry is renamed — the
 *  "Routes"/"Schedule" note above is exactly that case. Shared with
 *  MobileTabBar's More sheet, for the same reason the list is. */
export function navItemTitle(t: TFunction, item: Pick<NavItem, "title" | "url">): string {
  return t(`nav.item.${item.url.replace(/^\//, "")}`, { defaultValue: item.title });
}

/** A group heading in the interface language, keyed by its English label. */
export function navGroupLabel(t: TFunction, label: string): string {
  return t(`nav.group.${label}`, { defaultValue: label });
}

export function useNavVisibility(): NavVisibility {
  const { enabled: commercialEnabled } = useCommercialAccounts();
  const ctxFn = useServerFn(getFranchiseContext);
  // Same key the /franchise page uses, so the two share one fetch rather than
  // asking the same question twice on every navigation.
  const ctx = useQuery({
    queryKey: ["franchise", "ctx"],
    queryFn: () => ctxFn(),
    staleTime: 60_000,
  });
  // Fails CLOSED, unlike useCommercialAccounts, and the difference is
  // deliberate. There, falling open shows a slightly busier sidebar to an org
  // that opted out of clutter. Here, falling open would put a Royalties entry
  // in front of every single-location business on a slow request — which is
  // precisely what hiding it was meant to prevent.
  return { commercialEnabled, franchiseParent: ctx.data?.isParent === true };
}

export function isNavItemVisible(
  it: NavItem,
  role: AppRole | null,
  v: NavVisibility,
): boolean {
  return (
    canAccess(role, it.url) &&
    (!it.commercialOnly || v.commercialEnabled) &&
    (!it.franchiseParentOnly || v.franchiseParent)
  );
}

export function AppSidebar() {
  const { state, isMobile, setOpenMobile } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  // On a phone this sidebar is a full-screen Sheet, and nothing closed it.
  // Tapping Clients changed the route underneath and left the sheet covering
  // the app — reproduced three times on an iPhone 17 Pro, 2026-08-25, still
  // covering four seconds later. Closing on the PATHNAME rather than on each
  // link's onClick catches every route change, including the command palette
  // and anything added later that this file does not know about.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);
  const { role } = useMyRole();
  const { staff: me } = useMyProfile();
  const { t, i18n } = useTranslation();

  const isActive = (url: string) =>
    url === "/dashboard"
      ? pathname === "/dashboard"
      : pathname === url || pathname.startsWith(url + "/");

  const platformFn = useServerFn(getPlatformContext);
  const platform = useQuery({
    queryKey: ["platform", "ctx"],
    queryFn: () => platformFn(),
    staleTime: 60_000,
  });
  const isPlatformAdmin = !!platform.data?.isPlatformAdmin;

  // "In the nav rather than URL-only on purpose — a queue of things we refused
  // to guess about is worthless if nobody knows it exists" (the NAV_GROUPS note
  // above). A nav entry that looks identical whether the queue holds 0 items or
  // 40 does not tell anybody it exists either, which is why getReviewQueueCount
  // was written — "Open-item count for a nav badge. Cheap, and separate from the
  // list so the badge doesn't pull 200 rows on every page." It then sat unwired
  // for long enough to end up in the dead-machinery baseline.
  //
  // Only fetched when the nav item is actually visible to this role, and
  // deliberately allowed to fail quietly: a badge is not worth an error state.
  const reviewCountFn = useServerFn(getReviewQueueCount);
  const reviewCount = useQuery({
    queryKey: ["review-queue", "count"],
    queryFn: () => reviewCountFn(),
    enabled: canAccess(role, "/review"),
    staleTime: 60_000,
    retry: false,
  });
  const openReviews = reviewCount.data?.openCount ?? 0;

  // Three independent filters answering different questions. `canAccess` is
  // permission — a dispatcher may not see Payments. `commercialOnly` is what
  // kind of business this is, chosen by the owner about their own sidebar.
  // `franchiseParentOnly` is whether this org has locations at all. None is a
  // security boundary on its own; the routes and the server functions behind
  // them keep their own gates. See isNavItemVisible for why they live there.
  const navVisibility = useNavVisibility();
  const visibleGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => isNavItemVisible(it, role, navVisibility)),
  })).filter((g) => g.items.length > 0);

  if (isPlatformAdmin) {
    visibleGroups.push({
      label: "Platform",
      items: [{ title: "Platform admin", url: "/platform", icon: Shield }],
    });
  }

  return (
    // Docked at the reading start: the left edge in English, the right edge
    // in Arabic. The NEXT UP bar on My Day clears it with `start-` for the
    // same reason.
    <Sidebar collapsible="icon" side={dirFor(i18n.language) === "rtl" ? "right" : "left"}>
      <SidebarHeader>
        {/* When collapsed, the menu icons sit centered in a 2rem button within
            the icon rail; match that geometry exactly (same width, centered,
            no horizontal padding) so the mark lines up with the icon column. */}
        <Link
          to="/dashboard"
          className={
            collapsed
              ? "flex h-8 w-8 items-center justify-center text-sidebar-foreground"
              : "flex items-center gap-2 px-2 py-1.5 text-sidebar-foreground"
          }
          aria-label={APP_NAME}
        >
          <Logo
            variant="mark"
            className={collapsed ? "h-5 w-5 shrink-0" : "h-7 w-7 shrink-0"}
            style={{ color: "var(--brand-accent, currentColor)" }}
          />
          {!collapsed && (
            <span className="truncate text-base font-semibold tracking-tight">{APP_NAME}</span>
          )}
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {visibleGroups.map((group) => (
          <SidebarGroup key={group.label}>
            {!collapsed && <SidebarGroupLabel>{navGroupLabel(t, group.label)}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton
                      asChild
                      isActive={
                        isActive(item.url) || !!item.alsoActiveOn?.some((u) => isActive(u))
                      }
                      tooltip={
                        item.url === "/review" && openReviews > 0
                          ? `${navItemTitle(t, item)} (${openReviews})`
                          : navItemTitle(t, item)
                      }
                    >
                      <Link to={item.url} className="flex items-center gap-2" data-tour={item.url}>
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="truncate">{navItemTitle(t, item)}</span>}
                        {/* Expanded: a count. Collapsed to the icon rail there is
                            no room for one, so it degrades to a dot — still
                            "there is something here", which is the whole job. */}
                        {item.url === "/review" &&
                          openReviews > 0 &&
                          (collapsed ? (
                            <span
                              aria-hidden
                              className="absolute end-1 top-1 h-1.5 w-1.5 rounded-full bg-destructive"
                            />
                          ) : (
                            <span className="ms-auto shrink-0 rounded-full bg-destructive/15 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-destructive">
                              {openReviews > 99 ? "99+" : openReviews}
                            </span>
                          ))}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      {/* Who you are, at the foot of the nav, the way every tool of this shape
          puts it. Before this there was no indication anywhere in the sidebar
          of which account was signed in.
          Collapsed, it reduces to the avatar alone and keeps the 2rem geometry
          of the icon rail so it lines up with the nav icons above it. */}
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isActive("/profile")}
              tooltip={t("nav.yourAccount")}
            >
              <Link to="/profile" className="flex items-center gap-2">
                <UserAvatar
                  name={me?.display_name}
                  avatarPath={me?.avatar_url}
                  seed={me?.id}
                  className="h-5 w-5 shrink-0"
                  textClassName="text-3xs"
                />
                {!collapsed && (
                  <span className="truncate">{me?.display_name ?? t("nav.yourAccount")}</span>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
