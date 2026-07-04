import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Shield, AlertCircle } from "lucide-react";
import { getPlatformContext } from "@/lib/platform.functions";

export const Route = createFileRoute("/platform")({
  head: () => ({ meta: [{ title: "Platform admin" }, { name: "robots", content: "noindex" }] }),
  component: PlatformLayout,
});

const tabs = [
  { to: "/platform" as const, label: "Tenants" },
  { to: "/platform/revenue" as const, label: "Revenue" },
  { to: "/platform/health" as const, label: "Health" },
  { to: "/platform/audit" as const, label: "Audit" },
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
    <div className="p-2">
      <div className="mb-4 flex items-center gap-2">
        <Shield className="h-6 w-6" />
        <h1 className="text-2xl font-semibold">Platform admin</h1>
      </div>
      <nav className="mb-4 flex gap-1 overflow-x-auto border-b">
        {tabs.map((t) => (
          <Link
            key={t.to}
            to={t.to}
            activeOptions={{ exact: true }}
            className="px-3 py-2 text-sm font-medium text-muted-foreground border-b-2 border-transparent transition-colors hover:text-foreground data-[active=true]:border-primary data-[active=true]:text-foreground"
            activeProps={{ "data-active": "true" } as never}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
