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

export const Route = createFileRoute("/platform/tenants")({
  component: TenantsPage,
});

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  free: "outline",
  active: "default",
  past_due: "destructive",
  grace: "secondary",
  suspended: "destructive",
  canceled: "outline",
};

const STATUS_LABEL: Record<string, string> = {
  free: "Free",
  active: "Active",
  past_due: "Past due",
  grace: "Grace",
  suspended: "Suspended",
  canceled: "Canceled",
};

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
          <div className="flex gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name…"
                className="w-56 pl-8"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="rounded-md border bg-background px-2 py-1 text-sm"
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
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Clients</TableHead>
                  <TableHead className="text-right">Users</TableHead>
                  <TableHead>Stripe</TableHead>
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
                      <Badge variant={STATUS_VARIANT[r.billing_status] ?? "outline"}>
                        {STATUS_LABEL[r.billing_status] ?? r.billing_status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.active_client_count.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {r.users_count.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      {r.stripe_subscription_id ? (
                        <span className="text-xs text-emerald-600">Connected</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatWhen(r.last_activity_at)}
                    </TableCell>
                  </TableRow>
                ))}
                {!q.isLoading && filtered.length === 0 ? (
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
