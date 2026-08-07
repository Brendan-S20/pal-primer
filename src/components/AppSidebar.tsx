import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { getPlatformContext } from "@/lib/platform.functions";
import { getReviewQueueCount } from "@/lib/review-queue.functions";
import {
  LayoutDashboard,
  Users,
  MapPin,
  Route as RouteIcon,
  Truck,
  Trash2,
  MessageSquare,
  MessageCircleWarning,
  Receipt,
  BarChart3,
  LineChart,
  CreditCard,
  Upload,
  Settings as SettingsIcon,
  UserPlus,
  Building2,
  Package,
  Shield,
  Dna,
  ClipboardCheck,
  FileSpreadsheet,
  ShieldAlert,
} from "lucide-react";

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

export type NavItem = {
  title: string;
  url: string;
  icon: React.ComponentType<{ className?: string }>;
};

// Single source of nav truth — also consumed by MobileTabBar's "More" sheet so
// the phone nav can never drift from (or exceed) what the sidebar offers.
export const NAV_GROUPS: Array<{ label: string; items: NavItem[] }> = [
  {
    label: "Overview",
    items: [
      { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
      { title: "Leads", url: "/leads", icon: UserPlus },
    ],
  },
  {
    label: "Operations",
    items: [
      { title: "Clients", url: "/clients", icon: Users },
      { title: "Zones", url: "/zones", icon: MapPin },
      { title: "Routes", url: "/routes", icon: RouteIcon },
    ],
  },
  {
    label: "Field",
    items: [
      { title: "My day", url: "/my-day", icon: Truck },
      { title: "Waste log", url: "/waste-log", icon: Trash2 },
      { title: "Messages", url: "/messages", icon: MessageSquare },
      { title: "Concerns", url: "/concerns", icon: MessageCircleWarning },
      { title: "Neighbor canvassing", url: "/neighbors", icon: MapPin },
      { title: "DNA compliance", url: "/dna", icon: Dna },
    ],
  },
  {
    label: "Ops",
    items: [{ title: "Inventory", url: "/inventory", icon: Package }],
  },
  {
    label: "Billing",
    items: [
      { title: "Invoices", url: "/invoices", icon: Receipt },
      { title: "Payments", url: "/payments", icon: CreditCard },
      // BUILD-13: the accountant's pack. In the nav rather than URL-only
      // because the whole point is that an owner finds it in January without
      // having to be told it exists.
      { title: "Tax & accountant", url: "/tax-reports", icon: FileSpreadsheet },
      // BUILD-12: disputes get their own entry rather than living inside the
      // review queue. A chargeback has a deadline attached, and one buried
      // under visit-timestamp warnings is one nobody answers in time.
      { title: "Disputes", url: "/disputes", icon: ShieldAlert },
    ],
  },
  {
    label: "Insights",
    items: [
      { title: "Reports", url: "/reports", icon: BarChart3 },
      { title: "Analytics", url: "/analytics", icon: LineChart },
      // BUILD-10: guardrail 10.5's review queue. In the nav rather than
      // URL-only on purpose — a queue of things we refused to guess about
      // is worthless if nobody knows it exists.
      { title: "Needs review", url: "/review", icon: ClipboardCheck },
      // Royalties (/franchise) is hidden until multi-location is a real,
      // supported offering (per Brendan, 2026-07-14). The route still works
      // by URL for the rare royalty-parent org.
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

export function AppSidebar() {
  const { state } = useSidebar();
  const collapsed = state === "collapsed";
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role } = useMyRole();
  const { staff: me } = useMyProfile();

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

  const visibleGroups = NAV_GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => canAccess(role, it.url)),
  })).filter((g) => g.items.length > 0);

  if (isPlatformAdmin) {
    visibleGroups.push({
      label: "Platform",
      items: [{ title: "Platform admin", url: "/platform", icon: Shield }],
    });
  }

  return (
    <Sidebar collapsible="icon">
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
            {!collapsed && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.url}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive(item.url)}
                      tooltip={
                        item.url === "/review" && openReviews > 0
                          ? `${item.title} (${openReviews})`
                          : item.title
                      }
                    >
                      <Link to={item.url} className="flex items-center gap-2" data-tour={item.url}>
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="truncate">{item.title}</span>}
                        {/* Expanded: a count. Collapsed to the icon rail there is
                            no room for one, so it degrades to a dot — still
                            "there is something here", which is the whole job. */}
                        {item.url === "/review" &&
                          openReviews > 0 &&
                          (collapsed ? (
                            <span
                              aria-hidden
                              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-destructive"
                            />
                          ) : (
                            <span className="ml-auto shrink-0 rounded-full bg-destructive/15 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-destructive">
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
            <SidebarMenuButton asChild isActive={isActive("/profile")} tooltip="Your account">
              <Link to="/profile" className="flex items-center gap-2">
                <UserAvatar
                  name={me?.display_name}
                  avatarPath={me?.avatar_url}
                  seed={me?.id}
                  className="h-5 w-5 shrink-0"
                  textClassName="text-3xs"
                />
                {!collapsed && (
                  <span className="truncate">{me?.display_name ?? "Your account"}</span>
                )}
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
