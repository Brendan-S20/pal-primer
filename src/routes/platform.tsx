import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Shield, AlertCircle, LayoutDashboard, Building2, UserPlus, Mailbox, Package,
  Ticket, FileText, Users, Megaphone, TrendingUp, Activity, ScrollText,
} from "lucide-react";
import { getPlatformContext } from "@/lib/platform.functions";

export const Route = createFileRoute("/platform")({
  head: () => ({ meta: [{ title: "Platform admin" }, { name: "robots", content: "noindex" }] }),
  component: PlatformLayout,
});

const NAV = [
  {
    section: "Operations",
    items: [
      { to: "/platform/overview" as const, label: "Overview", icon: LayoutDashboard },
      { to: "/platform/tenants" as const, label: "Tenants", icon: Building2 },
      { to: "/platform/signup-requests" as const, label: "Signup requests", icon: Mailbox },
      { to: "/platform/invites" as const, label: "Invites", icon: UserPlus },
      { to: "/platform/users" as const, label: "Users", icon: Users },
    ],
  },
  {
    section: "Billing",
    items: [
      { to: "/platform/plans" as const, label: "Plans", icon: Package },
      { to: "/platform/coupons" as const, label: "Coupons", icon: Ticket },
      { to: "/platform/invoices" as const, label: "Invoices", icon: FileText },
      { to: "/platform/revenue" as const, label: "Revenue", icon: TrendingUp },
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

  if (ctx.isLoading) return <div className="p-6 text-muted-foreground">Loading…</div>;

  if (!ctx.data?.isPlatformAdmin) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" /> Platform admin
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                You don't have platform admin access. This console is reserved for
                superadmins who manage all tenants across the platform.
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen w-full bg-background">
      <aside className="hidden w-60 shrink-0 border-r bg-card/40 md:block">
        <div className="flex h-14 items-center gap-2 border-b px-4">
          <Shield className="h-5 w-5" />
          <span className="font-semibold">Platform admin</span>
        </div>
        <nav className="p-3 text-sm">
          {NAV.map((group) => (
            <div key={group.section} className="mb-4">
              <div className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.section}
              </div>
              <div className="flex flex-col gap-0.5">
                {group.items.map(({ to, label, icon: Icon }) => (
                  <Link
                    key={to}
                    to={to}
                    className="flex items-center gap-2 rounded-md px-2 py-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground data-[active=true]:bg-muted data-[active=true]:text-foreground"
                    activeProps={{ "data-active": "true" } as never}
                  >
                    <Icon className="h-4 w-4 shrink-0" />
                    <span className="truncate">{label}</span>
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </nav>
      </aside>
      <main className="min-w-0 flex-1">
        {/* mobile nav — simple horizontal scroll fallback */}
        <div className="flex gap-1 overflow-x-auto border-b bg-card/40 px-3 py-2 md:hidden">
          {NAV.flatMap((g) => g.items).map(({ to, label }) => (
            <Link
              key={to}
              to={to}
              className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted data-[active=true]:bg-muted data-[active=true]:text-foreground"
              activeProps={{ "data-active": "true" } as never}
            >
              {label}
            </Link>
          ))}
        </div>
        <div className="p-4 sm:p-6">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
