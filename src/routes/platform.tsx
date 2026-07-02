import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getPlatformContext,
  getPlatformStats,
  updateOrgPlan,
  startImpersonation,
  type PlatformOrgRow,
} from "@/lib/platform.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Shield, Building2, Users, DollarSign, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/platform")({
  component: PlatformPage,
});

const money = (c: number | null | undefined) =>
  `$${((c ?? 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const PLAN_STATUSES = ["trialing", "active", "past_due", "canceled", "paused"] as const;

function PlatformPage() {
  const ctxFn = useServerFn(getPlatformContext);
  const statsFn = useServerFn(getPlatformStats);
  const ctx = useQuery({ queryKey: ["platform", "ctx"], queryFn: () => ctxFn() });
  const stats = useQuery({
    queryKey: ["platform", "stats"],
    queryFn: () => statsFn(),
    enabled: !!ctx.data?.isPlatformAdmin,
  });

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

  const rows: PlatformOrgRow[] = stats.data?.rows ?? [];
  const totals = rows.reduce(
    (acc, r) => ({
      clients: acc.clients + Number(r.active_clients),
      users: acc.users + Number(r.users_count),
      rev: acc.rev + Number(r.revenue_mtd_cents),
      ar: acc.ar + Number(r.ar_open_cents),
    }),
    { clients: 0, users: 0, rev: 0, ar: 0 },
  );

  return (
    <div className="space-y-6 p-2">
      <div className="flex items-center gap-2">
        <Shield className="h-6 w-6" />
        <h1 className="text-2xl font-semibold">Platform admin</h1>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard icon={Building2} label="Organizations" value={String(rows.length)} />
        <StatCard icon={Users} label="Active clients" value={totals.clients.toLocaleString()} />
        <StatCard icon={DollarSign} label="MTD revenue" value={money(totals.rev)} />
        <StatCard icon={AlertCircle} label="AR open" value={money(totals.ar)} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Tenants</CardTitle>
        </CardHeader>
        <CardContent>
          {stats.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading tenants…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No organizations yet.</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Organization</TableHead>
                    <TableHead>Plan</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Clients</TableHead>
                    <TableHead className="text-right">Users</TableHead>
                    <TableHead className="text-right">MTD rev</TableHead>
                    <TableHead className="text-right">AR open</TableHead>
                    <TableHead></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TenantRow key={r.organization_id} row={r} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: any;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center justify-between">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </div>
      <div className="mt-2 text-2xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function statusVariant(status: string | null): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "active":
      return "default";
    case "trialing":
      return "secondary";
    case "past_due":
    case "canceled":
      return "destructive";
    default:
      return "outline";
  }
}

function TenantRow({ row }: { row: PlatformOrgRow }) {
  const [open, setOpen] = useState(false);
  const [tier, setTier] = useState(row.billing_tier ?? "");
  const [status, setStatus] = useState<string>(row.plan_status ?? "trialing");
  const qc = useQueryClient();
  const updateFn = useServerFn(updateOrgPlan);
  const mutation = useMutation({
    mutationFn: (payload: { billing_tier: string | null; plan_status: any }) =>
      updateFn({
        data: {
          organization_id: row.organization_id,
          billing_tier: payload.billing_tier,
          plan_status: payload.plan_status,
        },
      }),
    onSuccess: () => {
      toast.success("Plan updated");
      qc.invalidateQueries({ queryKey: ["platform", "stats"] });
      setOpen(false);
    },
    onError: (e: any) => toast.error(e.message ?? "Update failed"),
  });

  return (
    <>
      <TableRow>
        <TableCell className="font-medium">{row.organization_name}</TableCell>
        <TableCell>{row.billing_tier ?? <span className="text-muted-foreground">—</span>}</TableCell>
        <TableCell>
          <Badge variant={statusVariant(row.plan_status)}>{row.plan_status ?? "—"}</Badge>
        </TableCell>
        <TableCell className="text-right tabular-nums">{Number(row.active_clients).toLocaleString()}</TableCell>
        <TableCell className="text-right tabular-nums">{Number(row.users_count).toLocaleString()}</TableCell>
        <TableCell className="text-right tabular-nums">{money(row.revenue_mtd_cents)}</TableCell>
        <TableCell className="text-right tabular-nums">{money(row.ar_open_cents)}</TableCell>
        <TableCell className="text-right">
          <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
            Edit plan
          </Button>
        </TableCell>
      </TableRow>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit plan · {row.organization_name}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Billing tier</span>
              <Input value={tier} onChange={(e) => setTier(e.target.value)} placeholder="e.g. starter, pro, enterprise" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">Plan status</span>
              <Select value={status} onValueChange={setStatus}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() =>
                mutation.mutate({ billing_tier: tier.trim() || null, plan_status: status })
              }
              disabled={mutation.isPending}
            >
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
