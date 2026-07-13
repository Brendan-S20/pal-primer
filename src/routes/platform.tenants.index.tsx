import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listPlatformTenants, type PlatformTenantRow } from "@/lib/platform-overview.functions";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  TenantStatusBadge,
  TENANT_STATUS_LABEL as STATUS_LABEL,
} from "@/components/TenantStatusBadge";

export const Route = createFileRoute("/platform/tenants/")({
  component: TenantsPage,
});

function formatWhen(iso: string | null): string {
  if (!iso) return "—";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function TenantsPage() {
  const fn = useServerFn(listPlatformTenants);
  const q = useQuery({ queryKey: ["platform", "tenants"], queryFn: () => fn() });
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const rows: PlatformTenantRow[] = q.data?.rows ?? [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (statusFilter !== "all" && r.billing_status !== statusFilter) return false;
      if (s && !r.name.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [rows, search, statusFilter]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Tenants</h1>
        <p className="text-sm text-muted-foreground">
          Every organization on the platform. Click a row to open the tenant workspace.
        </p>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="text-base">
            {q.isLoading ? "Loading…" : `${filtered.length} tenants`}
          </CardTitle>
          <div className="flex flex-col gap-2 sm:flex-row">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name…"
                className="w-full pl-8 sm:w-56"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border bg-background px-2 py-2 text-sm sm:py-1"
            >
              <option value="all">All statuses</option>
              {Object.entries(STATUS_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {/* Mobile: card list */}
          <div className="flex flex-col gap-2 md:hidden">
            {filtered.map((r) => (
              <Link
                key={r.id}
                to="/platform/tenants/$id"
                params={{ id: r.id }}
                className="rounded-lg border p-3 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{r.name}</div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {r.plan_name ?? "No plan"} · {r.active_client_count.toLocaleString()} clients · {r.users_count.toLocaleString()} users
                    </div>
                  </div>
                  <TenantStatusBadge status={r.billing_status} className="shrink-0" />
                </div>
                <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    {r.stripe_subscription_id ? (
                      <span className="text-emerald-600">Active subscription</span>
                    ) : r.stripe_customer_id ? (
                      // A Stripe customer exists — "No Stripe" was misleading
                      // for canceled tenants (P1.13).
                      <span>No active subscription</span>
                    ) : (
                      <span>No active subscription</span>
                    )}
                  </span>
                  <span>Last: {formatWhen(r.last_activity_at)}</span>
                </div>
              </Link>
            ))}
            {!q.isLoading && filtered.length === 0 ? (
              <div className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
                No tenants match.
              </div>
            ) : null}
          </div>

          {/* Desktop: table */}
          <div className="hidden overflow-x-auto md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Clients</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead>Last payment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">
                      <Link
                        to="/platform/tenants/$id"
                        params={{ id: r.id }}
                        className="hover:underline"
                      >
                        {r.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      {r.plan_name ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      <TenantStatusBadge status={r.billing_status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.active_client_count.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.users_count.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {r.stripe_subscription_id ? (
                        <span className="text-xs text-emerald-600">Active subscription</span>
                      ) : r.stripe_customer_id ? (
                        <span className="text-xs text-muted-foreground">No active subscription</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">None</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatWhen(r.last_activity_at)}
                    </TableCell>
                  </TableRow>
                ))}
                {q.isLoading ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={`sk-${i}`}>
                      <TableCell colSpan={7}><Skeleton className="h-6 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No tenants match.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
