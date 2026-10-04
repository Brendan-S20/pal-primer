import { useEffect } from "react";
import { nativeTopBarStyle } from "@/lib/native-build";
import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Shield,
  AlertCircle,
  LayoutDashboard,
  Building2,
  UserPlus,
  Package,
  Puzzle,
  Ticket,
  FileText,
  Users,
  Megaphone,
  TrendingUp,
  Activity,
  ScrollText,
  Radar,
  ArrowLeft,
  LogOut,
  Loader2,
  Gift,
} from "lucide-react";
import { getPlatformContext } from "@/lib/platform.functions";
import { setMonitoringIdentity } from "@/lib/monitoring/client";
import { ReimpersonateListener } from "@/components/ReimpersonateListener";
import { signOutAndClearDevice } from "@/lib/offline/read-cache";
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
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/platform")({
  head: () => ({
    meta: [{ title: pageTitle("Platform admin") }, { name: "robots", content: "noindex" }],
  }),
  component: PlatformLayout,
});

const NAV = [
  {
    section: "Operations",
    items: [
      { to: "/platform/overview" as const, label: "Overview", icon: LayoutDashboard },
      { to: "/platform/tenants" as const, label: "Tenants", icon: Building2 },
      { to: "/platform/invites" as const, label: "Invites", icon: UserPlus },
      { to: "/platform/users" as const, label: "Users", icon: Users },
      { to: "/platform/signals" as const, label: "Franchise signals", icon: Radar },
    ],
  },
  {
    section: "Billing",
    items: [
      { to: "/platform/plans" as const, label: "Plans", icon: Package },
      { to: "/platform/addons" as const, label: "Add-ons", icon: Puzzle },
      { to: "/platform/coupons" as const, label: "Coupons", icon: Ticket },
      { to: "/platform/invoices" as const, label: "Invoices", icon: FileText },
      { to: "/platform/revenue" as const, label: "Revenue", icon: TrendingUp },
      { to: "/platform/referrals" as const, label: "Referrals", icon: Gift },
    ],
  },
  {
    section: "System",
    items: [
      { to: "/platform/announcements" as const, label: "Announcements", icon: Megaphone },
      { to: "/platform/health" as const, label: "Health", icon: Activity },
      { to: "/platform/audit" as const, label: "Audit", icon: ScrollText },
    ],
  },
];

function PlatformLayout() {
  const ctxFn = useServerFn(getPlatformContext);
  const ctx = useQuery({ queryKey: ["platform", "ctx"], queryFn: () => ctxFn() });

  // Error reports from the console name the admin by id, as the tenant shell
  // does for everyone else. An admin with no org is sent here by the
  // _authenticated layout before it sets the identity, so without this every
  // error from the console arrived in Sentry as nobody. Off in dev and test.
  const adminId = ctx.data?.isPlatformAdmin ? ctx.data.userId : undefined;
  useEffect(() => {
    if (adminId) setMonitoringIdentity({ userId: adminId });
  }, [adminId]);

  if (ctx.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin shrink-0" /> Loading platform admin…
      </div>
    );
  }

  if (!ctx.data?.isPlatformAdmin) {
    return (
      <div className="mx-auto max-w-lg p-4 sm:p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 shrink-0" /> Platform admin
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm text-muted-foreground">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                You don't have platform admin access. This console is reserved for superadmins who
                manage all tenants across the platform.
              </div>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/dashboard">
                <ArrowLeft className="mr-1 h-4 w-4 shrink-0" /> Back to app
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        {/* BUG-2: lets an expired impersonation tab ask for a fresh session. */}
        <ReimpersonateListener />
        <PlatformSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <PlatformHeader />
          <main className="min-w-0 flex-1 px-4 py-4 sm:px-6 sm:py-6">
            <div className="mx-auto w-full max-w-6xl">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function PlatformSidebar() {
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();

  // ── THE TENANT SHELL GOT THIS; THIS ONE DID NOT ─────────────────────────
  //
  // AppSidebar closes the mobile Sheet on every pathname change. PlatformSidebar
  // is a separate component and was left behind, and that matters MORE here, not
  // less: the platform shell has no MobileTabBar, so its SidebarTrigger renders
  // unconditionally, and the platform routes are the one place on a phone where
  // this Sheet is actually reachable. Tapping a destination changed the route
  // underneath and left the sheet covering the console.
  //
  // On the pathname rather than per-link, same as AppSidebar, so the command
  // palette and any programmatic navigation are covered too.
  useEffect(() => {
    if (isMobile) setOpenMobile(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  return (
    <Sidebar collapsible="offcanvas">
      <SidebarHeader className="border-b">
        <div className="flex items-center gap-2 px-2 py-1.5">
          <Shield className="h-5 w-5 text-primary shrink-0" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">Platform admin</div>
            <div className="truncate text-2xs text-muted-foreground">HoundStack</div>
          </div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {NAV.map((group) => (
          <SidebarGroup key={group.section}>
            <SidebarGroupLabel>{group.section}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map(({ to, label, icon: Icon }) => {
                  const active = currentPath === to || currentPath.startsWith(to + "/");
                  return (
                    <SidebarMenuItem key={to}>
                      <SidebarMenuButton asChild isActive={active}>
                        <Link to={to} className="flex items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0" />
                          <span className="truncate">{label}</span>
                        </Link>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
    </Sidebar>
  );
}

function PlatformHeader() {
  const currentPath = useRouterState({ select: (r) => r.location.pathname });
  const all: Array<{ to: string; label: string }> = NAV.flatMap((g) =>
    g.items.map((i) => ({ to: i.to as string, label: i.label })),
  );
  const label =
    all.find((i) => currentPath === i.to || currentPath.startsWith(i.to + "/"))?.label ??
    "Platform";

  const handleSignOut = async () => {
    await signOutAndClearDevice();
    window.location.href = "/auth";
  };

  return (
    <header
      // NATIVE ONLY — same bar, same fault as the staff shell's. Not verified
      // on a device: reaching /platform needs a platform-admin account.
      style={nativeTopBarStyle(3.5)}
      className="sticky top-[var(--hs-banner-h,0px)] z-30 flex h-14 items-center gap-2 border-b bg-card/80 px-3 backdrop-blur sm:px-4"
    >
      <SidebarTrigger className="min-h-11 min-w-11" />
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <Shield className="h-4 w-4 shrink-0 text-primary sm:hidden" />
        <div className="truncate text-sm font-semibold sm:text-base">{label}</div>
      </div>
      {/* Platform admins live in the console — the only exit is Sign out
          (the tenant app has no meaning for a platform-only account). */}
      <Button
        variant="ghost"
        size="icon"
        aria-label="Sign out"
        className="min-h-11 min-w-11"
        onClick={handleSignOut}
      >
        <LogOut className="h-4 w-4 shrink-0" />
      </Button>
    </header>
  );
}
