import { Link, useRouterState } from "@tanstack/react-router";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import {
  LayoutDashboard,
  Users,
  MapPin,
  Route as RouteIcon,
  CloudSun,
  Truck,
  Trash2,
  MessageSquare,
  Receipt,
  BarChart3,
  LineChart,
  CreditCard,
  Upload,
  Sparkles,
  Settings as SettingsIcon,
  UserPlus,
  Building2,
  Package,
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

type NavItem = { title: string; url: string; icon: React.ComponentType<{ className?: string }> };

const GROUPS: Array<{ label: string; items: NavItem[] }> = [
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
      { title: "Weather", url: "/weather", icon: CloudSun },
    ],
  },
  {
    label: "Field",
    items: [
      { title: "My day", url: "/my-day", icon: Truck },
      { title: "Waste log", url: "/waste-log", icon: Trash2 },
      { title: "Messages", url: "/messages", icon: MessageSquare },
    ],
  },
  {
    label: "Ops",
    items: [
      { title: "Inventory", url: "/inventory", icon: Package },
    ],
  },
  {
    label: "Billing",
    items: [
      { title: "Invoices", url: "/invoices", icon: Receipt },
      { title: "Billing", url: "/billing", icon: CreditCard },
    ],
  },
  {
    label: "Insights",
    items: [
      { title: "Reports", url: "/reports", icon: BarChart3 },
      { title: "Analytics", url: "/analytics", icon: LineChart },
      { title: "Franchise", url: "/franchise", icon: Building2 },
      { title: "AI tools", url: "/ai-tools", icon: Sparkles },
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
    url === "/dashboard" ? pathname === "/dashboard" : pathname === url || pathname.startsWith(url + "/");

  const visibleGroups = GROUPS.map((g) => ({
    ...g,
    items: g.items.filter((it) => canAccess(role, it.url)),
  })).filter((g) => g.items.length > 0);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link to="/dashboard" className="flex items-center gap-2 px-2 py-1.5 text-sm font-semibold">
          <div className="grid h-7 w-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
            <Truck className="h-4 w-4" />
          </div>
          {!collapsed && <span className="truncate">{APP_NAME}</span>}
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
                      <Link to={item.url} className="flex items-center gap-2">
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

