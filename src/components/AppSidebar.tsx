import { useEffect, useState } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMyRole, canAccess, type AppRole } from "@/hooks/useMyRole";
import { getPlatformContext } from "@/lib/platform.functions";
import { getFranchiseContext } from "@/lib/franchise.functions";
import { getReviewQueueCount } from "@/lib/review-queue.functions";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import { SETUP_PATH, promptsSetup, stepsFor, useSetupGuide } from "@/lib/setup-guide";
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
  PanelLeftClose,
  PanelLeftOpen,
  UserCog,
  GraduationCap,
  Sparkles,
  ChevronDown,
} from "lucide-react";
import { Megaphone, Tags } from "lucide-react";
import { openTimeClock, useMyClock } from "@/components/TimeClock";
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
import { useCommercialAccounts, useServiceLines } from "@/components/CommercialOnly";
import { useClientTexting } from "@/hooks/useClientTexting";

export type NavItem = {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Only meaningful for an org that serves HOAs, apartment complexes or dog
   *  parks. Hidden when the owner has said they do not — see CommercialOnly. */
  commercialOnly?: boolean;
  /** Only meaningful for a business that runs pet waste removal
   *  (organizations.service_lines). Hidden for a dog walker, a sitter or a
   *  groomer; fails OPEN like commercialOnly, and reads as pet waste while
   *  the answer is loading -- see useServiceLines. The gating table is
   *  PET_WASTE_MODULES in lib/service-lines. */
  petWasteOnly?: boolean;
  /** Only meaningful for a business that runs training. Hidden until the
   *  service lines are known (TrainingOnly), since nearly no business does. */
  trainingOnly?: boolean;
  /** Only meaningful for a franchise PARENT — an org with `is_franchise_parent`
   *  set, or with children linked to it. For everyone else the screen behind it
   *  is a page about locations they do not have. Unlike `commercialOnly` this
   *  fails CLOSED while the answer is unknown: see `useNavVisibility`. */
  franchiseParentOnly?: boolean;
  /** Only shown once this business can text its own clients
   *  (useClientTexting, lib/client-texting). Until then the page behind it is
   *  a "coming soon" with nothing to do on it. Fails CLOSED while loading,
   *  like the texting controls themselves. */
  textingOnly?: boolean;
  /** Other pages this entry stands for, so it stays highlighted there. Reports
   *  is one entry for three pages (see components/ReportsNav). */
  alsoActiveOn?: readonly string[];
  /** Not signposted to a technician. The same filter settings.tsx applies to
   *  every section without `techVisible`, so an entry that points into
   *  Settings is shown to exactly the people the Settings menu shows it to.
   *  Hiding only: the route's own role check (ROUTE_ROLES) is untouched. */
  officeOnly?: boolean;
};

// Single source of nav truth — also consumed by MobileTabBar's "More" sheet so
// the phone nav can never drift from (or exceed) what the sidebar offers.
// ── THE FIVE AN OWNER OPENS MOST, FIRST (QA row 36, 2026-10-15) ─────────
//
// Dashboard, Schedule, Clients, Invoices and Payments are the evening round,
// and they were spread over three groups with Inbox, Leads and Campaigns in
// between. They are the first group now, in that order, and what is opened
// once a season (zones, imports, settings) is at the bottom. The phone's More
// sheet is built from this list minus the tab bar's own three, so on a phone
// it now opens on Invoices and Payments. Order only: every entry is filtered
// exactly as before (isNavItemVisible), so nobody sees anything new.
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      // "Schedule", not "Routes": there is no `routes` table (a route is
      // visits filtered by a day and a tech), and MobileTabBar already called
      // this Schedule, so desktop and phone were naming the same screen two
      // different things. Label only; the URL stays /routes because moving it
      // would touch the dispatcher landing redirect, the onboarding tour
      // anchors and the nightly push deep-links, to change a string no
      // customer ever reads.
      { title: "Schedule", url: "/routes", icon: RouteIcon },
      { title: "Clients", url: "/clients", icon: Users },
      { title: "Invoices", url: "/invoices", icon: Receipt },
      { title: "Payments", url: "/payments", icon: CreditCard },
    ],
  },
  {
    label: "Operations",
    items: [
      // Everything waiting on the office in one list: texts to answer,
      // concerns, needs-review records, disputes and unread alerts, each
      // linking to the page where it is done (launch pass, 2026-10). First
      // after the five above, because it is the evening round's next stop.
      { title: "Inbox", url: "/inbox", icon: InboxIcon },
      // Messages and Concerns were under Field until the launch pass
      // (2026-10). Neither is a field screen: both are the office answering
      // customers, and neither is open to a technician (ROUTE_ROLES gives
      // both to owner, office manager and dispatcher only), so for the one
      // role Field exists for they were never in it at all.
      { title: "Messages", url: "/messages", icon: MessageSquare, textingOnly: true },
      { title: "Leads", url: "/leads", icon: UserPlus },
      { title: "Requests", url: "/concerns", icon: MessageCircleWarning },
      {
        title: "Training packages",
        url: "/training-packages",
        icon: GraduationCap,
        trainingOnly: true,
      },
      { title: "Campaigns", url: "/campaigns", icon: Megaphone },
      // Inventory and Timesheets were a sixth group called "Ops", two groups
      // below one called "Operations": the same word twice, once abbreviated,
      // in the sidebar and again in the phone's More sheet, which is built from
      // this list. Nobody could say which of the two a thing belonged in, so
      // they are one group.
      //
      // The time clock's office half. Here rather than under Field because
      // the people who open it are the owner and the office manager; the
      // techs' half is the card at the top of My day.
      { title: "Timesheets", url: "/timesheets", icon: Timer },
      { title: "Expenses", url: "/expenses", icon: ReceiptText },
      { title: "Inventory", url: "/inventory", icon: Package },
    ],
  },
  {
    label: "Billing",
    items: [
      { title: "Quotes", url: "/quotes", icon: FileSignature },
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
      // Pet-waste-only: dump trips and loads hauled. A dog walker's day has
      // neither, and on the tech's tab bar this slot goes to My schedule.
      { title: "Waste log", url: "/waste-log", icon: Trash2, petWasteOnly: true },
      { title: "Neighbor canvassing", url: "/neighbors", icon: MapPin },
      // Commercial-only: /dna lists clients filtered to account_type
      // 'commercial', so for a residential-only business this entry opens a
      // permanently empty workspace. Hidden by commercialOnly below rather
      // than removed, because the orgs that do serve HOAs bill violation
      // fines from it. And pet-waste-only: DNA-matching dropped waste back to
      // a resident's dog means nothing to a business that does not pick it up.
      { title: "DNA compliance", url: "/dna", icon: Dna, commercialOnly: true, petWasteOnly: true },
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
      // Moved down from Operations (QA row 36): service areas are drawn once
      // and revisited rarely.
      { title: "Zones", url: "/zones", icon: MapPin },
      // #861: what the business sells and charges lived only under Settings,
      // so an owner coming back to change a price had to know to open
      // Settings first. Same page and same audience (ROUTE_ROLES:
      // owner + office manager) as the Settings tab.
      { title: "Services", url: "/settings/services", icon: Tags },
      { title: "Import", url: "/imports", icon: Upload },
      // The team page already exists as Settings → Users & roles, and an
      // owner looking for "who works for me" does not think to open
      // Settings. Same page, same audience as that section (officeOnly
      // mirrors settings.tsx's tech filter; ROUTE_ROLES is unchanged).
      { title: "Team", url: "/settings/users", icon: UserCog, officeOnly: true },
      { title: "Settings", url: "/settings", icon: SettingsIcon },
    ],
  },
];

// ── FIRST RUN: THE WALKTHROUGH'S FOUR, AND THE REST BEHIND ONE TAP (D6) ──
//
// Onboarding audit, 2026-11-09: an owner who had just created a workspace
// landed on /onboarding and /setup with Dashboard, Schedule, Clients,
// Invoices, Payments, Inbox, Leads, Campaigns, Waste log, Neighbor canvassing
// and the rest down the side, before the business had a name, an address or a
// price. The pilot walkthrough read that as half-built.
//
// While the guided setup is open and not finished, the sidebar leads with what
// the walkthrough needs and puts every other entry behind one disclosure.
// Nothing is removed: the disclosure opens the same groups, filtered by the
// same isNavItemVisible. Finishing setup, "Not now", "Finish later" or
// dismissing the checklist each give the whole sidebar back. The phone needs
// no change: its tab bar already keeps everything else behind More.

/** The guided setup's own entry, first while it is the job in hand. */
export const SETUP_NAV_ITEM: NavItem = { title: "Guided setup", url: SETUP_PATH, icon: Sparkles };

/** The entries the walkthrough uses, after Setup: Schedule, Clients and
 *  Services are where its steps send the owner, Settings is where everything
 *  else lives. */
export const FIRST_RUN_NAV_URLS = [
  "/routes",
  "/clients",
  // #861: the price step sends the owner here, and a first-run sidebar that
  // offered only Settings left them hunting for it.
  "/settings/services",
  "/settings",
] as const;

export const FIRST_RUN_GROUP_LABEL = "Get started";

/**
 * Whether the sidebar is in first-run focus. The same people and the same
 * moment as the setup banner (SetupGuideBanner): the owner, with the guide
 * open, not dismissed, and steps left. ON while the status is still loading,
 * so a new owner does not see the full list flash first; OFF if the read
 * failed, because a nav that cannot tell should not hide anything.
 */
export function isFirstRun(o: {
  role: AppRole | null;
  phase: "unknown" | "open" | "closed";
  status:
    { dismissed: boolean; steps: ReadonlyArray<{ done: boolean; gate?: string }> } | undefined;
  failed: boolean;
}): boolean {
  if (!promptsSetup(o.role) || o.phase !== "open" || o.failed) return false;
  if (!o.status) return true;
  if (o.status.dismissed) return false;
  const steps = stepsFor(o.status.steps, o.role);
  return steps.some((s) => !s.done);
}

/** The first-run sidebar: the walkthrough's entries, and every other visible
 *  entry in its usual group for the disclosure. */
export function firstRunNav(
  groups: ReadonlyArray<{ label: string; items: NavItem[] }>,
  role: AppRole | null,
  v: NavVisibility,
): { core: NavItem[]; rest: Array<{ label: string; items: NavItem[] }> } {
  const all = groups.flatMap((g) => g.items);
  const core = [
    SETUP_NAV_ITEM,
    ...FIRST_RUN_NAV_URLS.map((u) => all.find((i) => i.url === u)).filter((i): i is NavItem => !!i),
  ].filter((i) => isNavItemVisible(i, role, v));
  const coreUrls = new Set(core.map((i) => i.url));
  const rest = groups
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => !coreUrls.has(i.url) && isNavItemVisible(i, role, v)),
    }))
    .filter((g) => g.items.length > 0);
  return { core, rest };
}

/** isFirstRun for the signed-in person, on the banner's own query. */
export function useFirstRun(): boolean {
  const { role } = useMyRole();
  const guide = useSetupGuide();
  // The shared query (D5/D9): one answer for the banner, checklist, /setup
  // and the nav, refreshed by every mutation that finishes a step.
  const q = useOnboardingStatus({ enabled: promptsSetup(role) && guide.phase === "open" });
  return isFirstRun({ role, phase: guide.phase, status: q.data, failed: q.isError });
}

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
export type NavVisibility = {
  commercialEnabled: boolean;
  franchiseParent: boolean;
  /** organizations.service_lines includes pet_waste. */
  petWaste: boolean;
  /** organizations.service_lines is known and includes training. */
  training: boolean;
  /** This business can text its own clients (useClientTexting). */
  texting: boolean;
};

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
  const { petWaste, lines, known } = useServiceLines();
  const training = known && lines.includes("training");
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
  const texting = useClientTexting();
  return {
    commercialEnabled,
    franchiseParent: ctx.data?.isParent === true,
    petWaste,
    training,
    texting,
  };
}

export function isNavItemVisible(it: NavItem, role: AppRole | null, v: NavVisibility): boolean {
  return (
    canAccess(role, it.url) &&
    (!it.commercialOnly || v.commercialEnabled) &&
    (!it.petWasteOnly || v.petWaste) &&
    (!it.trainingOnly || v.training) &&
    (!it.franchiseParentOnly || v.franchiseParent) &&
    (!it.officeOnly || role !== "tech") &&
    (!it.textingOnly || v.texting)
  );
}

function TimeClockSidebarItem({ collapsed }: { collapsed: boolean }) {
  const clock = useMyClock();
  const { t } = useTranslation();
  if (!clock.staff) return null;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        tooltip={`${t("clock.label")} · ${clock.status}`}
        onClick={openTimeClock}
        data-time-clock-row=""
        aria-label={collapsed ? `${t("clock.label")} · ${clock.status}` : undefined}
      >
        <Timer
          className={`h-4 w-4 shrink-0 ${clock.open ? "text-emerald-600 dark:text-emerald-400" : ""}`}
          aria-hidden="true"
        />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate">{t("clock.label")}</span>
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {clock.status}
            </span>
          </>
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const { state, isMobile, setOpenMobile, setRailOpen, toggleSidebar } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (r) => r.location.pathname });

  // On a phone this sidebar is a full-screen Sheet, and nothing closed it.
  // Tapping Clients changed the route underneath and left the sheet covering
  // the app — reproduced three times on an iPhone 17 Pro, 2026-08-25, still
  // covering four seconds later. Closing on the PATHNAME rather than on each
  // link's onClick catches every route change, including the command palette
  // and anything added later that this file does not know about.
  // The rail's overlay panel (below 1024px) closes on the same signal. The
  // docked column's expanded or collapsed choice does not: that one is kept.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
    setRailOpen(false);
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
  const firstRun = useFirstRun();
  const [showAllChosen, setShowAllChosen] = useState(false);
  const focus = firstRun ? firstRunNav(NAV_GROUPS, role, navVisibility) : null;
  // Opened by hand, or because the page on screen is one of the entries
  // behind it (reached from the palette or a link): the lit entry is shown.
  const showAll = showAllChosen || !!focus?.rest.some((g) => g.items.some((i) => isActive(i.url)));
  const visibleGroups = focus
    ? [{ label: FIRST_RUN_GROUP_LABEL, items: focus.core }, ...(showAll ? focus.rest : [])]
    : NAV_GROUPS.map((g) => ({
        ...g,
        items: g.items.filter((it) => isNavItemVisible(it, role, navVisibility)),
      })).filter((g) => g.items.length > 0);

  // On /settings/users both Team and Settings match the path. The longer,
  // more specific entry is the one lit.
  const visibleUrls = visibleGroups.flatMap((g) => g.items.map((i) => i.url));
  const shadowedBy = (url: string) =>
    visibleUrls.some((u) => u !== url && u.startsWith(url + "/") && isActive(u));

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
      <SidebarHeader className={!isMobile && !collapsed ? "flex-row items-center" : undefined}>
        {/* When collapsed, the menu icons sit centered in a 2rem button within
            the icon rail; match that geometry exactly (same width, centered,
            no horizontal padding) so the mark lines up with the icon column. */}
        <Link
          to="/dashboard"
          className={
            collapsed
              ? "flex h-8 w-8 items-center justify-center text-sidebar-foreground touch:h-11 touch:w-11"
              : "flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sidebar-foreground"
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
        {/* The sidebar's own way to the labels and back, wherever it is
            docked. Below 1024px (QA row 34) it opens the panel over the
            page, which closes on a route change, Escape, a tap outside it,
            or this same button. From 1024 it switches the column between
            the icons and the labels beside the page, and the choice is kept
            on this device (#499), the same as the header toggle and
            Cmd/Ctrl+B. */}
        {!isMobile && (
          <button
            type="button"
            onClick={toggleSidebar}
            aria-expanded={!collapsed}
            aria-label={collapsed ? t("nav.expandMenu") : t("nav.collapseMenu")}
            title={collapsed ? t("nav.expandMenu") : t("nav.collapseMenu")}
            data-sidebar="rail-toggle"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground touch:h-11 touch:w-11"
          >
            {!collapsed ? (
              <PanelLeftClose className="h-4 w-4 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            ) : (
              <PanelLeftOpen className="h-4 w-4 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            )}
          </button>
        )}
      </SidebarHeader>
      <SidebarContent>
        {visibleGroups.map((group, groupIndex) => (
          <SidebarGroup key={group.label}>
            {!collapsed && <SidebarGroupLabel>{navGroupLabel(t, group.label)}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton
                      asChild
                      isActive={
                        (isActive(item.url) && !shadowedBy(item.url)) ||
                        !!item.alsoActiveOn?.some((u) => isActive(u))
                      }
                      tooltip={
                        item.url === "/review" && openReviews > 0
                          ? `${navItemTitle(t, item)} (${openReviews})`
                          : navItemTitle(t, item)
                      }
                    >
                      <Link
                        to={item.url}
                        className="flex items-center gap-2"
                        data-tour={item.url}
                        // On the rail the label is not drawn, and a tooltip
                        // is a description, not a name.
                        aria-label={collapsed ? navItemTitle(t, item) : undefined}
                      >
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
                {/* First run: the rest of the sidebar, one tap away. Under the
                    walkthrough's entries rather than at the foot, so it is on
                    screen on a 13-inch laptop without scrolling the nav. */}
                {focus && groupIndex === 0 && (
                  <SidebarMenuItem>
                    <SidebarMenuButton
                      type="button"
                      onClick={() => setShowAllChosen(!showAll)}
                      aria-expanded={showAll}
                      aria-label={
                        collapsed
                          ? showAll
                            ? t("nav.hideAllMenus")
                            : t("nav.showAllMenus")
                          : undefined
                      }
                      tooltip={showAll ? t("nav.hideAllMenus") : t("nav.showAllMenus")}
                      data-first-run-more=""
                      className="text-sidebar-foreground/70"
                    >
                      <ChevronDown
                        className={`h-4 w-4 shrink-0 transition-transform ${showAll ? "rotate-180" : ""}`}
                        aria-hidden="true"
                      />
                      {!collapsed && (
                        <span className="min-w-0 truncate">
                          {showAll ? t("nav.hideAllMenus") : t("nav.showAllMenus")}
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )}
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
          {/* The time clock, for whoever has one (a staff record). Its row in
              the More sheet is the phone's way in; this is the way in
              wherever the sidebar is the menu. Opens the same sheet. */}
          {me && <TimeClockSidebarItem collapsed={collapsed} />}
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              isActive={isActive("/profile")}
              tooltip={t("nav.yourAccount")}
            >
              <Link
                to="/profile"
                className="flex items-center gap-2"
                aria-label={collapsed ? t("nav.yourAccount") : undefined}
              >
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
