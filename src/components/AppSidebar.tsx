import { Link, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { getPlatformContext } from "@/lib/platform.functions";
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
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
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

export type NavItem = { title: string; url: string; icon: React.ComponentType<{ className?: string }> };

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
    ],
  },
  {
    label: "Insights",
    items: [
      { title: "Reports", url: "/reports", icon: BarChart3 },
      { title: "Analytics", url: "/analytics", icon: LineChart },
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
                    <SidebarMenuButton asChild isActive={isActive(item.url)} tooltip={item.title}>
                      <Link to={item.url} className="flex items-center gap-2" data-tour={item.url}>
                        <item.icon className="h-4 w-4 shrink-0" />
                        {!collapsed && <span className="truncate">{item.title}</span>}
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}
