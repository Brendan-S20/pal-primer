import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getTenantDetail,
  listTenantNotes, addTenantNote, deleteTenantNote,
  listTenantFeatureFlags, setTenantFeatureFlag,
  listTenantInvoices, listTenantAudit,
  suspendTenant, reactivateTenant, grantGracePeriod, softDeleteTenant,
  type TenantDetail, type TenantNote, type TenantFlagRow, type TenantInvoiceRow, type TenantAuditRow,
} from "@/lib/platform-tenant.functions";
import { startImpersonation } from "@/lib/platform.functions";
import { launchImpersonationTab } from "@/lib/impersonation-launch";
import { humanizeRole } from "@/lib/humanize";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "sonner";
import { ArrowLeft, ExternalLink, MoreHorizontal, Trash2, UserCog } from "lucide-react";
import { TenantStatusBadge } from "@/components/TenantStatusBadge";

export const Route = createFileRoute("/platform/tenants/$id")({
  head: () => ({ meta: [{ title: "Tenant · Platform admin" }, { name: "robots", content: "noindex" }] }),
  component: TenantDetailPage,
});

function fmtCents(cents: number, ccy = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: ccy.toUpperCase() }).format(cents / 100);
}
function fmtDate(iso: string | null) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function TenantDetailPage() {
  const { id } = Route.useParams();
  const qc = useQueryClient();
  const detailFn = useServerFn(getTenantDetail);
  const detail = useQuery({
    queryKey: ["platform", "tenant", id],
    queryFn: () => detailFn({ data: { organization_id: id } }),
  });

  if (detail.isLoading) return <div className="text-sm text-muted-foreground">Loading tenant…</div>;
  if (detail.isError) return <div className="text-sm text-destructive">{(detail.error as Error).message}</div>;
  const t = detail.data!;

  return (
    <div className="space-y-6">
      <TenantHeader t={t} onChange={() => qc.invalidateQueries({ queryKey: ["platform", "tenant", id] })} />

      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex-wrap">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="billing">Billing</TabsTrigger>
          <TabsTrigger value="invoices">Invoices</TabsTrigger>
          <TabsTrigger value="flags">Feature flags</TabsTrigger>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-4"><OverviewTab t={t} /></TabsContent>
        <TabsContent value="users" className="pt-4"><UsersTab t={t} /></TabsContent>
        <TabsContent value="billing" className="pt-4"><BillingTab t={t} /></TabsContent>
        <TabsContent value="invoices" className="pt-4"><InvoicesTab orgId={id} /></TabsContent>
        <TabsContent value="flags" className="pt-4"><FlagsTab orgId={id} /></TabsContent>
        <TabsContent value="notes" className="pt-4"><NotesTab orgId={id} /></TabsContent>
        <TabsContent value="audit" className="pt-4"><AuditTab orgId={id} /></TabsContent>
      </Tabs>
    </div>
  );
}

function TenantHeader({ t, onChange }: { t: TenantDetail; onChange: () => void }) {
  const suspendFn = useServerFn(suspendTenant);
  const reactivateFn = useServerFn(reactivateTenant);
  const graceFn = useServerFn(grantGracePeriod);
  const deleteFn = useServerFn(softDeleteTenant);
  const impersonateFn = useServerFn(startImpersonation);
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [graceDays, setGraceDays] = useState("14");
  const [deleteOpen, setDeleteOpen] = useState(false);

  const suspendM = useMutation({
    mutationFn: () => suspendFn({ data: { organization_id: t.id, reason } }),
    onSuccess: () => { toast.success("Tenant suspended"); setReason(""); onChange(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const reactivateM = useMutation({
    mutationFn: () => reactivateFn({ data: { organization_id: t.id } }),
    onSuccess: () => { toast.success("Tenant reactivated"); onChange(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const graceM = useMutation({
    mutationFn: () => graceFn({ data: { organization_id: t.id, days: parseInt(graceDays, 10) } }),
    onSuccess: () => { toast.success(`Grace period granted (${graceDays} days)`); onChange(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteM = useMutation({
    mutationFn: () => deleteFn({ data: { organization_id: t.id, confirm_name: confirmName } }),
    onSuccess: () => { toast.success("Tenant deleted"); setConfirmName(""); setDeleteOpen(false); onChange(); },
    onError: (e) => toast.error((e as Error).message),
  });
  const [impersonateUser, setImpersonateUser] = useState<string>("");
  const impersonateM = useMutation({
    mutationFn: (targetUserId: string) =>
      launchImpersonationTab(impersonateFn as never, {
        organizationId: t.id,
        targetUserId,
      }),
    onSuccess: (res) => {
      toast.success(`Impersonating ${res.targetEmail} in a new tab`);
      setImpersonateUser("");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="flex flex-col gap-3">
      <Link to="/platform/tenants" className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Back to tenants
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{t.name}</h1>
            <TenantStatusBadge status={t.billing_status} />
            {t.deleted_at && <Badge variant="destructive">Deleted</Badge>}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {t.plan_name ?? "No plan"} · {t.active_client_count} clients · {t.users.length} users
            {" · "}created {fmtDate(t.created_at)}
          </div>
          {t.suspended_reason && (
            <div className="mt-1 text-sm text-destructive">Suspended: {t.suspended_reason}</div>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <AlertDialog onOpenChange={(open) => { if (!open) setImpersonateUser(""); }}>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" disabled={impersonateM.isPending || !!t.deleted_at}>
                <UserCog className="mr-1 h-4 w-4" /> Impersonate
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Impersonate a user in {t.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  You'll open a read/write session AS the selected user in a new tab. Your own
                  platform-admin session in this tab is not affected. Everything you do is logged
                  to the audit trail.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1">
                <Label htmlFor="imp-user">User to impersonate</Label>
                <select
                  id="imp-user"
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={impersonateUser}
                  onChange={(e) => setImpersonateUser(e.target.value)}
                >
                  <option value="">Select a user…</option>
                  {t.users.map((u) => (
                    <option key={u.user_id} value={u.user_id}>
                      {(u.email ?? u.user_id)} ({u.role.replace(/_/g, " ")})
                    </option>
                  ))}
                </select>
                {t.users.length === 0 && (
                  <p className="text-xs text-muted-foreground">This tenant has no users to impersonate.</p>
                )}
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  disabled={!impersonateUser || impersonateM.isPending}
                  onClick={(e) => {
                    if (!impersonateUser) { e.preventDefault(); return; }
                    impersonateM.mutate(impersonateUser);
                  }}
                >
                  {impersonateM.isPending ? "Starting…" : "Impersonate"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {(t.billing_status === "suspended" || t.billing_status === "canceled" || t.plan_status === "canceled") && (
            <Button size="sm" onClick={() => reactivateM.mutate()} disabled={reactivateM.isPending || !!t.deleted_at}>
              Reactivate
            </Button>
          )}
          {t.billing_status !== "active" && t.billing_status !== "free" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" disabled={graceM.isPending || !!t.deleted_at}>
                  Grant grace period
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Grant {t.name} a grace period?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The tenant can keep adding clients until the grace period expires, giving
                    them time to reactivate their plan from their own Billing settings.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-1">
                  <Label htmlFor="grace-days">Duration</Label>
                  <select
                    id="grace-days"
                    className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={graceDays}
                    onChange={(e) => setGraceDays(e.target.value)}
                  >
                    <option value="7">7 days</option>
                    <option value="14">14 days</option>
                    <option value="30">30 days</option>
                  </select>
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction disabled={graceM.isPending} onClick={() => graceM.mutate()}>
                    Grant grace
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {t.billing_status !== "suspended" && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="destructive" size="sm" disabled={!!t.deleted_at}>Suspend</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Suspend {t.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Members will lose app access until reactivated. Data is preserved.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <div className="space-y-1">
                  <Label htmlFor="reason">Reason (required)</Label>
                  <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. payment failed after grace period" />
                </div>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction disabled={!reason.trim() || suspendM.isPending} onClick={() => suspendM.mutate()}>
                    Suspend
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {/* Destructive Delete lives behind an overflow menu, one deliberate
              step away from the primary Impersonate/Suspend row (H5 #5). */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="More actions" disabled={!!t.deleted_at}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>More actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                disabled={!!t.deleted_at}
                onSelect={(e) => { e.preventDefault(); setDeleteOpen(true); }}
              >
                <Trash2 className="mr-2 h-4 w-4" /> Delete tenant
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <AlertDialog open={deleteOpen} onOpenChange={(o) => { setDeleteOpen(o); if (!o) setConfirmName(""); }}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Soft-delete {t.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The tenant is hidden from lists but data is preserved. Type the organization name to confirm.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={t.name} />
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction disabled={confirmName.trim() !== t.name || deleteM.isPending}
                  onClick={() => deleteM.mutate()}>
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ t }: { t: TenantDetail }) {
  const rows: Array<[string, React.ReactNode]> = [
    ["Organization ID", <code className="text-xs">{t.id}</code>],
    ["Plan", t.plan_name ?? "-"],
    ["Active clients", t.active_client_count.toLocaleString()],
    ["Users", t.users.length.toLocaleString()],
    ["Stripe customer", t.stripe_customer_id ?? "-"],
    ["Stripe subscription", t.stripe_subscription_id ?? "-"],
    ["Grace expires", fmtDate(t.grace_expires_at)],
    ["Suspended at", fmtDate(t.suspended_at)],
    ["Created", fmtDate(t.created_at)],
  ];
  return (
    <Card><CardContent className="pt-6">
      <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-4 border-b py-2 text-sm last:border-0 sm:last:border-b">
            <dt className="text-muted-foreground">{k}</dt>
            <dd className="text-right font-medium">{v}</dd>
          </div>
        ))}
      </dl>
    </CardContent></Card>
  );
}

function UsersTab({ t }: { t: TenantDetail }) {
  return (
    <Card><CardContent className="pt-6">
      {t.users.length === 0 ? (
        <div className="text-sm text-muted-foreground">No users in this organization.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>Email</TableHead><TableHead>Role</TableHead><TableHead>Joined</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {t.users.map((u) => (
              <TableRow key={u.user_id + u.role}>
                <TableCell className="font-medium">{u.email ?? <code className="text-xs">{u.user_id.slice(0, 8)}</code>}</TableCell>
                <TableCell><Badge variant="outline">{humanizeRole(u.role)}</Badge></TableCell>
                <TableCell className="text-sm text-muted-foreground">{fmtDate(u.created_at)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CardContent></Card>
  );
}

function BillingTab({ t }: { t: TenantDetail }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Subscription</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="flex justify-between border-b py-2">
          <span className="text-muted-foreground">Current plan</span>
          <span className="font-medium">{t.plan_name ?? "-"}</span>
        </div>
        <div className="flex justify-between border-b py-2">
          <span className="text-muted-foreground">Billing status</span>
          <TenantStatusBadge status={t.billing_status} />
        </div>
        <div className="flex justify-between border-b py-2">
          <span className="text-muted-foreground">Stripe customer</span>
          <span className="font-mono text-xs">{t.stripe_customer_id ?? "-"}</span>
        </div>
        <div className="flex justify-between border-b py-2">
          <span className="text-muted-foreground">Stripe subscription</span>
          <span className="font-mono text-xs">{t.stripe_subscription_id ?? "-"}</span>
        </div>
        <div className="pt-2 text-xs text-muted-foreground">
          Plan changes, coupons, and the Stripe portal are managed from the tenant's own Billing settings.
        </div>
      </CardContent>
    </Card>
  );
}

function InvoicesTab({ orgId }: { orgId: string }) {
  const fn = useServerFn(listTenantInvoices);
  const q = useQuery({
    queryKey: ["platform", "tenant", orgId, "invoices"],
    queryFn: () => fn({ data: { organization_id: orgId } }),
  });
  const rows: TenantInvoiceRow[] = q.data?.rows ?? [];
  return (
    <Card><CardContent className="pt-6">
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No platform invoices for this tenant.</div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Number</TableHead><TableHead>Status</TableHead>
              <TableHead className="text-right">Due</TableHead>
              <TableHead className="text-right">Paid</TableHead>
              <TableHead>Issued</TableHead><TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.number ?? r.id.slice(0, 8)}</TableCell>
                <TableCell><Badge variant="outline">{r.status}</Badge></TableCell>
                <TableCell className="text-right tabular-nums">{fmtCents(r.amount_due_cents, r.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{fmtCents(r.amount_paid_cents, r.currency)}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{fmtDate(r.issued_at)}</TableCell>
                <TableCell>
                  {r.hosted_invoice_url && (
                    <a href={r.hosted_invoice_url} target="_blank" rel="noreferrer"
                       className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                      Stripe <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </CardContent></Card>
  );
}

function FlagsTab({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listTenantFeatureFlags);
  const setFn = useServerFn(setTenantFeatureFlag);
  const q = useQuery({
    queryKey: ["platform", "tenant", orgId, "flags"],
    queryFn: () => listFn({ data: { organization_id: orgId } }),
  });
  const setM = useMutation({
    mutationFn: (input: { key: string; value: boolean | null; justification?: string | null }) =>
      setFn({ data: { organization_id: orgId, ...input } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "tenant", orgId, "flags"] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const rows: TenantFlagRow[] = q.data?.rows ?? [];

  return (
    <Card><CardContent className="pt-6">
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">
          No feature flags have been defined yet.
        </div>
      ) : (
        <ul className="divide-y">
          {rows.map((f) => <FlagRow key={f.key} f={f} onSet={(v) => setM.mutate({ key: f.key, value: v })} />)}
        </ul>
      )}
    </CardContent></Card>
  );
}

function FlagRow({ f, onSet }: { f: TenantFlagRow; onSet: (value: boolean | null) => void }) {
  const overridden = f.override_value !== null;
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium">{f.label}</span>
          <code className="text-xs text-muted-foreground">{f.key}</code>
          {overridden && <Badge variant="secondary" className="text-[10px]">override</Badge>}
        </div>
        {f.description && <div className="text-xs text-muted-foreground">{f.description}</div>}
        <div className="mt-1 text-xs text-muted-foreground">
          Default: {f.default_value ? "on" : "off"} · Effective: <span className="font-medium">{f.effective ? "on" : "off"}</span>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <Switch checked={f.effective} onCheckedChange={(v) => onSet(v)} />
        {overridden && (
          <Button variant="ghost" size="sm" onClick={() => onSet(null)}>Reset</Button>
        )}
      </div>
    </li>
  );
}

function NotesTab({ orgId }: { orgId: string }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listTenantNotes);
  const addFn = useServerFn(addTenantNote);
  const delFn = useServerFn(deleteTenantNote);
  const q = useQuery({
    queryKey: ["platform", "tenant", orgId, "notes"],
    queryFn: () => listFn({ data: { organization_id: orgId } }),
  });
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<"note" | "call" | "email" | "incident">("note");

  const addM = useMutation({
    mutationFn: () => addFn({ data: { organization_id: orgId, body, kind } }),
    onSuccess: () => {
      setBody("");
      qc.invalidateQueries({ queryKey: ["platform", "tenant", orgId, "notes"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const delM = useMutation({
    mutationFn: (note_id: string) => delFn({ data: { note_id } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "tenant", orgId, "notes"] }),
    onError: (e) => toast.error((e as Error).message),
  });

  const rows: TenantNote[] = q.data?.rows ?? [];
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 pt-6">
          <div className="flex items-center gap-2">
            <Label>Kind</Label>
            <select value={kind} onChange={(e) => setKind(e.target.value as any)}
              className="rounded-md border bg-background px-2 py-1 text-sm">
              <option value="note">Note</option>
              <option value="call">Call</option>
              <option value="email">Email</option>
              <option value="incident">Incident</option>
            </select>
          </div>
          <Textarea placeholder="Add an internal support note…" value={body}
            onChange={(e) => setBody(e.target.value)} rows={3} />
          <div className="flex justify-end">
            <Button size="sm" disabled={!body.trim() || addM.isPending} onClick={() => addM.mutate()}>Add note</Button>
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          {q.isLoading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-muted-foreground">No notes yet.</div>
          ) : (
            <ul className="divide-y">
              {rows.map((n) => (
                <li key={n.id} className="py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{n.kind}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {n.author_email ?? n.author_user_id?.slice(0, 8) ?? "system"} · {fmtDate(n.created_at)}
                      </span>
                    </div>
                    <Button size="sm" variant="ghost" onClick={() => delM.mutate(n.id)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="mt-1 whitespace-pre-wrap text-sm">{n.body}</div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function AuditTab({ orgId }: { orgId: string }) {
  const fn = useServerFn(listTenantAudit);
  const q = useQuery({
    queryKey: ["platform", "tenant", orgId, "audit"],
    queryFn: () => fn({ data: { organization_id: orgId } }),
  });
  const rows: TenantAuditRow[] = q.data?.rows ?? [];
  return (
    <Card><CardContent className="pt-6">
      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground">No admin actions on this tenant yet.</div>
      ) : (
        <ul className="divide-y">
          {rows.map((r) => (
            <li key={r.id} className="py-3 text-sm">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{r.action}</Badge>
                  <span className="text-xs text-muted-foreground">
                    by {r.actor_email ?? r.actor_user_id.slice(0, 8)}
                  </span>
                </div>
                <span className="text-xs text-muted-foreground">{fmtDate(r.created_at)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </CardContent></Card>
  );
}
