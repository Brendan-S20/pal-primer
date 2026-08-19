import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { listPlatformTenants, type PlatformTenantRow } from "@/lib/platform-overview.functions";
import { suspendTenant, reactivateTenant } from "@/lib/platform-tenant.functions";
import {
  Card, CardContent, CardHeader, CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Search } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  TenantStatusBadge,
  TENANT_STATUS_LABEL as STATUS_LABEL,
} from "@/components/TenantStatusBadge";
import { isValidOrgName } from "@/lib/dna-linkage";
import { useRowSelection } from "@/hooks/useRowSelection";
import { useConfirmDialog } from "@/components/ConfirmDialog";

export const Route = createFileRoute("/platform/tenants/")({
  component: TenantsPage,
});

function formatWhen(iso: string | null): string {
  if (!iso) return "-";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / (24 * 3600 * 1000));
  if (days === 0) return "today";
  if (days === 1) return "1d ago";
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

/** Not a billing_status — `deleted_at` is orthogonal to it — so it is its own
 *  entry in the same picker rather than another row of STATUS_LABEL. */
const DELETED_FILTER = "deleted";

function TenantsPage() {
  const fn = useServerFn(listPlatformTenants);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<string>("all");

  // Soft-deleted tenants are the ONLY way back to a tenant that was deleted by
  // mistake: the detail page's Restore button is behind this filter, and before
  // it existed the row was gone from the console for good.
  const showDeleted = statusFilter === DELETED_FILTER;
  const q = useQuery({
    queryKey: ["platform", "tenants", showDeleted ? "deleted" : "live"],
    queryFn: () => fn({ data: { include_deleted: showDeleted } }),
  });

  const rows: PlatformTenantRow[] = q.data?.rows ?? [];
  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    return rows.filter((r) => {
      // The deleted view is exclusive: `include_deleted` widens the query to
      // both, and this narrows it back to the ones that are actually deleted.
      if (showDeleted ? !r.deleted_at : !!r.deleted_at) return false;
      if (!showDeleted && statusFilter !== "all" && r.billing_status !== statusFilter) return false;
      if (s && !r.name.toLowerCase().includes(s)) return false;
      return true;
    });
  }, [rows, search, statusFilter, showDeleted]);

  // Multi-select for bulk suspend / unsuspend (Invoices-page pattern; the
  // per-tenant fns are platform-admin gated server-side). Selection clears on
  // filter changes so a bulk action never hits hidden rows.
  const qc = useQueryClient();
  const { confirm, dialog: bulkDialog } = useConfirmDialog();
  const suspendFn = useServerFn(suspendTenant);
  const reactivateFn = useServerFn(reactivateTenant);
  const visibleIds = useMemo(() => filtered.map((r) => r.id), [filtered]);
  const sel = useRowSelection(visibleIds, `${search}|${statusFilter}`);
  const selectedRows = useMemo(
    () => filtered.filter((r) => sel.isSelected(r.id)),
    [filtered, sel],
  );
  // A deleted tenant is not a suspend/unsuspend target — restoring it is the
  // only thing to do with it, and that lives on the detail page.
  const suspendable = selectedRows.filter((r) => !r.deleted_at && r.billing_status !== "suspended");
  const unsuspendable = selectedRows.filter((r) => !r.deleted_at && r.billing_status === "suspended");

  // Bulk suspend needs the same required reason the tenant-detail dialog
  // collects (it lands on the tenant's suspension banner + audit log).
  const [suspendOpen, setSuspendOpen] = useState(false);
  const [suspendReason, setSuspendReason] = useState("");

  const bulkSuspendM = useMutation({
    mutationFn: async (v: { ids: string[]; reason: string }) => {
      const results = await Promise.allSettled(
        v.ids.map((organization_id) =>
          suspendFn({ data: { organization_id, reason: v.reason } }),
        ),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Suspended ${r.ok} of ${r.ok + r.failed} tenants — ${r.failed} failed`);
      else toast.success(`Suspended ${r.ok} tenant${r.ok === 1 ? "" : "s"}`);
      setSuspendOpen(false);
      setSuspendReason("");
      sel.clear();
      qc.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const bulkUnsuspendM = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((organization_id) => reactivateFn({ data: { organization_id } })),
      );
      const ok = results.filter((r) => r.status === "fulfilled").length;
      return { ok, failed: results.length - ok };
    },
    onSuccess: (r) => {
      if (r.failed)
        toast.error(`Unsuspended ${r.ok} of ${r.ok + r.failed} tenants — ${r.failed} failed`);
      else toast.success(`Unsuspended ${r.ok} tenant${r.ok === 1 ? "" : "s"}`);
      sel.clear();
      qc.invalidateQueries({ queryKey: ["platform", "tenants"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

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
            {q.isLoading
              ? "Loading…"
              : showDeleted
                ? `${filtered.length} deleted tenant${filtered.length === 1 ? "" : "s"} — open one to restore it`
                : `${filtered.length} tenants`}
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
              <option value={DELETED_FILTER}>Deleted (soft)</option>
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {/* Bulk action bar */}
          {sel.count > 0 && (
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border bg-accent/40 px-4 py-2 text-sm shadow-sm">
              <span className="font-medium">{sel.count} selected</span>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={bulkSuspendM.isPending || suspendable.length === 0}
                  title={suspendable.length === 0 ? "All selected tenants are already suspended" : undefined}
                  onClick={() => setSuspendOpen(true)}
                >
                  Suspend{suspendable.length > 0 ? ` (${suspendable.length})` : ""}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={bulkUnsuspendM.isPending || unsuspendable.length === 0}
                  title={unsuspendable.length === 0 ? "No suspended tenants selected" : undefined}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Unsuspend ${unsuspendable.length} tenant${unsuspendable.length === 1 ? "" : "s"}?`,
                        description:
                          "Each tenant is restored to active (with a live subscription) or free, and its suspension reason is cleared.",
                        confirmLabel: "Unsuspend",
                      })
                    )
                      bulkUnsuspendM.mutate(unsuspendable.map((r) => r.id));
                  }}
                >
                  {bulkUnsuspendM.isPending
                    ? "Unsuspending…"
                    : `Unsuspend${unsuspendable.length > 0 ? ` (${unsuspendable.length})` : ""}`}
                </Button>
                <Button size="sm" variant="ghost" onClick={sel.clear}>
                  Clear
                </Button>
              </div>
            </div>
          )}

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
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium">{r.name}</span>
                      {r.deleted_at && (
                        <Badge variant="destructive" className="shrink-0">Deleted</Badge>
                      )}
                      {!isValidOrgName(r.name) && (
                        <Badge variant="outline" className="shrink-0 text-amber-600">Review name</Badge>
                      )}
                    </div>
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
                  <TableHead className="w-10">
                    <Checkbox
                      checked={sel.allSelected}
                      onCheckedChange={sel.toggleAll}
                      aria-label="Select all tenants"
                    />
                  </TableHead>
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
                    <TableCell>
                      <Checkbox
                        checked={sel.isSelected(r.id)}
                        onCheckedChange={(v) => sel.toggle(r.id, v === true)}
                        aria-label={`Select ${r.name}`}
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      <span className="flex items-center gap-1.5">
                        <Link
                          to="/platform/tenants/$id"
                          params={{ id: r.id }}
                          className="hover:underline"
                        >
                          {r.name}
                        </Link>
                        {r.deleted_at && <Badge variant="destructive">Deleted</Badge>}
                        {!isValidOrgName(r.name) && (
                          <Badge variant="outline" className="text-amber-600">Review name</Badge>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      {r.plan_name ?? <span className="text-muted-foreground">-</span>}
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
                      <TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell>
                    </TableRow>
                  ))
                ) : filtered.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">
                      No tenants match.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      {bulkDialog}

      {/* Bulk suspend reason (required, same as the tenant-detail dialog) */}
      <Dialog open={suspendOpen} onOpenChange={(o) => !o && setSuspendOpen(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              Suspend {suspendable.length} tenant{suspendable.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              Suspended tenants lose access until reactivated. The reason is shown on each
              tenant's suspension banner and recorded in the audit log.
              {selectedRows.length > suspendable.length
                ? ` ${selectedRows.length - suspendable.length} already-suspended selection(s) are skipped.`
                : ""}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            rows={3}
            autoFocus
            placeholder="Reason (required), e.g. payment failure follow-up"
            value={suspendReason}
            onChange={(e) => setSuspendReason(e.target.value)}
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setSuspendOpen(false)} disabled={bulkSuspendM.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!suspendReason.trim() || bulkSuspendM.isPending}
              onClick={() =>
                bulkSuspendM.mutate({
                  ids: suspendable.map((r) => r.id),
                  reason: suspendReason.trim(),
                })
              }
            >
              {bulkSuspendM.isPending ? "Suspending…" : "Suspend"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
