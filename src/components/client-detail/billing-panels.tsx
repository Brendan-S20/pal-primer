// Billing panels for the client detail page: invoice history + generation,
// autopay recovery, add-on services, and the inline prepay control. Moved
// verbatim from the route file during the client-detail refactor (Stage 2).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { FileText, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { InvoiceStatusBadge } from "@/components/InvoiceStatusBadge";
import {
  EmptyState,
  MetaChip,
  SectionLabel,
  StatusChip,
} from "@/components/client-detail/primitives";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  getClientBillingSummary,
  generateInvoiceForClient,
  getInvoicePortalLink,
  voidInvoice,
  resumeAutopay,
  getInvoiceDetail,
} from "@/lib/invoices.functions";
import { EditDrawer, DrawerFooter } from "@/components/client-detail/EditDrawer";
import { formatDateTime, formatDay } from "@/lib/format";
import {
  listAddonServices,
  listClientAddons,
  createAddonCharge,
  voidAddonCharge,
  createAddonSubscription,
  setAddonSubscriptionStatus,
} from "@/lib/addons.functions";

export function money(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

export function PrepayInline({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (n: number) => void;
}) {
  const [count, setCount] = useState("4");
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        const n = parseInt(count, 10);
        if (n > 0) onSubmit(n);
      }}
    >
      <Input
        type="number"
        min="1"
        max="52"
        value={count}
        onChange={(e) => setCount(e.target.value)}
        className="h-8 w-16"
        aria-label="Number of visits to bill"
      />
      <Button type="submit" size="sm" variant="outline" disabled={disabled}>
        Bill next
      </Button>
    </form>
  );
}

// Finding #11: the Messages empty-state points users to "send a first message
// from a client's detail page," but no composer existed anywhere. This is that
// entry point — it originates a thread by sending the first SMS via the same
// path replies use, so the conversation appears on both this page and Messages.
export function BillingPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const summaryFn = useServerFn(getClientBillingSummary);
  const genFn = useServerFn(generateInvoiceForClient);
  const portalLinkFn = useServerFn(getInvoicePortalLink);
  const voidFn = useServerFn(voidInvoice);

  const { data } = useQuery({
    queryKey: ["billing-summary", clientId],
    queryFn: () => summaryFn({ data: { clientId } }),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["billing-summary", clientId] });

  const genMut = useMutation({
    mutationFn: () => {
      const through = new Date().toISOString().slice(0, 10);
      return genFn({ data: { clientId, through } });
    },
    onSuccess: (r: any) => {
      if (r?.id) {
        toast.success("Invoice generated");
        invalidate();
      } else {
        toast.info("Nothing to invoice yet");
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // In-app payments: staff copy the client's portal billing link (pays inside
  // our app) instead of minting a hosted checkout.stripe.com URL.
  const linkMut = useMutation({
    mutationFn: (id: string) => portalLinkFn({ data: { invoiceId: id } }),
    onSuccess: (r: { url: string }) => {
      navigator.clipboard.writeText(r.url).then(
        () => toast.success("Portal link copied to clipboard"),
        () => toast.error("Copy failed, opening in new tab"),
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const voidMut = useMutation({
    mutationFn: (id: string) => voidFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Invoice voided");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const invoices = data?.invoices ?? [];
  const payments = data?.payments ?? [];
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);

  return (
    <>
      {dialog}
      <section className="rounded-lg border bg-card shadow-sm p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium">Invoices</h2>
            {data && (
              <p className="mt-1 text-xs text-muted-foreground">
                {data.openCount} open · ${(data.openTotalCents / 100).toFixed(2)} outstanding
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={genMut.isPending}
            onClick={() => genMut.mutate()}
          >
            {genMut.isPending ? "Generating…" : "Generate invoice from unbilled visits"}
          </Button>
        </div>

        {invoices.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              compact
              icon={FileText}
              title="No invoices yet"
              description="Generate one from unbilled visits or prepay a service."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y text-sm">
            {invoices.map((inv: any) => (
              <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <div
                  className="cursor-pointer"
                  role="button"
                  tabIndex={0}
                  onClick={() => setDetailInvoiceId(inv.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDetailInvoiceId(inv.id);
                    }
                  }}
                >
                  <div className="flex items-center gap-2">
                    <Link
                      to="/invoices/$invoiceId"
                      params={{ invoiceId: inv.id }}
                      className="font-mono text-xs text-primary hover:underline"
                    >
                      #{inv.id.slice(0, 8)}
                    </Link>
                    <InvoiceStatusBadge status={inv.status} />
                    <span className="text-xs text-muted-foreground">{inv.kind}</span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {inv.period_start
                      ? `${formatDay(inv.period_start)} to ${formatDay(inv.period_end)}`
                      : formatDay(inv.created_at)}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className="font-medium">${(inv.total_cents / 100).toFixed(2)}</span>
                  {inv.status === "open" && (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={linkMut.isPending}
                        onClick={() => linkMut.mutate(inv.id)}
                      >
                        Copy portal link
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={voidMut.isPending}
                        onClick={async () => {
                          if (
                            await confirm({
                              title: "Void this invoice?",
                              destructive: true,
                              confirmLabel: "Void invoice",
                            })
                          )
                            voidMut.mutate(inv.id);
                        }}
                      >
                        Void
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border bg-card shadow-sm p-5">
        <h2 className="text-sm font-medium">Payment history</h2>
        {payments.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              compact
              icon={FileText}
              title="No payments recorded"
              description="Payments appear here once an invoice is paid."
            />
          </div>
        ) : (
          <ul className="mt-3 divide-y text-sm">
            {payments.map((p: any) => (
              <li key={p.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="text-muted-foreground">
                    {formatDay(p.paid_at ?? p.created_at)}
                  </span>
                  {p.invoice_id && (
                    <Link
                      to="/invoices/$invoiceId"
                      params={{ invoiceId: p.invoice_id }}
                      className="ml-2 font-mono text-xs text-primary hover:underline"
                    >
                      #{p.invoice_id.slice(0, 8)}
                    </Link>
                  )}
                  <StatusChip status={p.status} className="ml-2" />
                </span>
                <span className="font-medium">${(p.amount_cents / 100).toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <InvoiceDetailDrawer invoiceId={detailInvoiceId} onClose={() => setDetailInvoiceId(null)} />
    </>
  );
}

// ── Invoice detail drawer (QA follow-up 2.3) ────────────────────────────────

function InvoiceDetailDrawer({
  invoiceId,
  onClose,
}: {
  invoiceId: string | null;
  onClose: () => void;
}) {
  const detailFn = useServerFn(getInvoiceDetail);
  const { data, isLoading } = useQuery({
    queryKey: ["invoice-detail", invoiceId],
    queryFn: () => detailFn({ data: { invoiceId: invoiceId! } }),
    enabled: !!invoiceId,
  });
  const inv = data?.invoice as any;
  const lines = data?.lineItems ?? [];
  const pays = data?.payments ?? [];

  return (
    <EditDrawer
      open={!!invoiceId}
      onClose={onClose}
      title={inv ? `Invoice #${String(inv.id).slice(0, 8)}` : "Invoice"}
      size="md"
    >
      {isLoading || !inv ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="space-y-5 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <InvoiceStatusBadge status={inv.status} />
            <span className="text-xs text-muted-foreground">{inv.kind}</span>
            <span className="text-xs text-muted-foreground">
              {inv.period_start
                ? `${formatDay(inv.period_start)} to ${formatDay(inv.period_end)}`
                : formatDateTime(inv.created_at)}
            </span>
          </div>

          <div>
            <SectionLabel>Line items</SectionLabel>
            {lines.length === 0 ? (
              <p className="mt-1.5 text-muted-foreground">No line items recorded.</p>
            ) : (
              <ul className="mt-1.5 divide-y">
                {lines.map((l: any) => (
                  <li key={l.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="min-w-0 truncate">{l.description}</span>
                    <span className="shrink-0 font-medium">${(l.amount_cents / 100).toFixed(2)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2 flex items-center justify-between border-t pt-2 font-medium">
              <span>Total</span>
              <span>${(inv.total_cents / 100).toFixed(2)}</span>
            </div>
          </div>

          <div>
            <SectionLabel>Payment attempts</SectionLabel>
            {pays.length === 0 ? (
              <p className="mt-1.5 text-muted-foreground">No payment attempts yet.</p>
            ) : (
              <ul className="mt-1.5 divide-y">
                {pays.map((p: any) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 py-1.5">
                    <span className="text-muted-foreground">
                      {formatDateTime(p.paid_at ?? p.created_at)}
                    </span>
                    <span className="flex items-center gap-2">
                      <StatusChip status={p.status} />
                      <span className="font-medium">${(p.amount_cents / 100).toFixed(2)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <DrawerFooter>
            <Link
              to="/invoices/$invoiceId"
              params={{ invoiceId: inv.id }}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90"
            >
              Open full invoice
            </Link>
          </DrawerFooter>
        </div>
      )}
    </EditDrawer>
  );
}

export function AutopayResume({
  clientId,
  lastError,
  onDone,
}: {
  clientId: string;
  lastError?: string | null;
  onDone: () => void;
}) {
  const resumeFn = useServerFn(resumeAutopay);
  const mut = useMutation({
    mutationFn: () => resumeFn({ data: { clientId } }),
    onSuccess: () => {
      toast.success("Autopay resumed. Next nightly run will retry");
      onDone();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="mt-2 space-y-1 text-right">
      <StatusChip status="failed" label="Paused after failed charges" />
      {lastError && (
        <div className="max-w-[220px] truncate text-xs text-muted-foreground" title={lastError}>
          {lastError}
        </div>
      )}
      <Button size="sm" variant="outline" onClick={() => mut.mutate()} disabled={mut.isPending}>
        {mut.isPending ? "Resuming…" : "Resume autopay"}
      </Button>
    </div>
  );
}

// ── Overview cards (client-detail rework, 2026-07-14) ───────────────────────

export function AddonsPanel({ clientId }: { clientId: string }) {
  const qc = useQueryClient();
  const listSvc = useServerFn(listAddonServices);
  const listAddons = useServerFn(listClientAddons);
  const createCharge = useServerFn(createAddonCharge);
  const voidCharge = useServerFn(voidAddonCharge);
  const createSub = useServerFn(createAddonSubscription);
  const setSubStatus = useServerFn(setAddonSubscriptionStatus);

  const { data: svcData } = useQuery({
    queryKey: ["addon-services"],
    queryFn: () => listSvc({ data: {} }),
  });
  const { data: addonsData } = useQuery({
    queryKey: ["client-addons", clientId],
    queryFn: () => listAddons({ data: { clientId } }),
  });

  // Spec 3.4: the add forms stay collapsed behind "Add add-on".
  const [showAdd, setShowAdd] = useState(false);
  const [svcId, setSvcId] = useState("");
  const [qty, setQty] = useState("1");
  const [priceOverride, setPriceOverride] = useState("");
  const [subSvcId, setSubSvcId] = useState("");
  const [subFreq, setSubFreq] = useState("monthly");
  const [subPrice, setSubPrice] = useState("");

  const services: any[] = svcData?.services ?? [];
  const charges: any[] = addonsData?.charges ?? [];
  const subs: any[] = addonsData?.subscriptions ?? [];

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["client-addons", clientId] });
    qc.invalidateQueries({ queryKey: ["credit", clientId] });
  };

  const chargeMut = useMutation({
    mutationFn: () => {
      if (!svcId) throw new Error("Pick an add-on");
      return createCharge({
        data: {
          clientId,
          addonServiceId: svcId,
          quantity: Math.max(1, parseInt(qty, 10) || 1),
          unitPriceCents:
            priceOverride.trim() === "" ? undefined : Math.round(parseFloat(priceOverride) * 100),
          source: "office",
        },
      });
    },
    onSuccess: () => {
      toast.success("Add-on billed");
      setSvcId("");
      setQty("1");
      setPriceOverride("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const voidMut = useMutation({
    mutationFn: (id: string) => voidCharge({ data: { chargeId: id } }),
    onSuccess: () => {
      toast.success("Voided");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const subMut = useMutation({
    mutationFn: () => {
      if (!subSvcId || !subPrice.trim()) throw new Error("Pick service and price");
      return createSub({
        data: {
          clientId,
          addonServiceId: subSvcId,
          frequency: subFreq as any,
          priceCents: Math.round(parseFloat(subPrice) * 100),
        },
      });
    },
    onSuccess: () => {
      toast.success("Recurring add-on started");
      setSubSvcId("");
      setSubPrice("");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const statusMut = useMutation({
    mutationFn: (v: { id: string; status: "active" | "paused" | "canceled" }) =>
      setSubStatus({ data: v }),
    onSuccess: () => invalidate(),
  });

  return (
    <section className="rounded-lg border bg-card shadow-sm p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">Add-ons &amp; cross-sells</h2>
        {!showAdd && (
          <Button size="sm" variant="outline" onClick={() => setShowAdd(true)}>
            <Plus className="mr-1 h-3.5 w-3.5" /> Add add-on
          </Button>
        )}
      </div>

      {showAdd && (
        <div className="mt-4 rounded-md border bg-muted/20 p-3">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <SectionLabel>One-time add-on</SectionLabel>
              <form
                className="mt-2 grid grid-cols-6 items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  chargeMut.mutate();
                }}
              >
                <div className="col-span-3">
                  <Label htmlFor="addon-svc" className="text-xs">
                    Service
                  </Label>
                  <select
                    id="addon-svc"
                    className="mt-0.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={svcId}
                    onChange={(e) => {
                      setSvcId(e.target.value);
                      const s = services.find((x) => x.id === e.target.value);
                      if (s) setPriceOverride((s.unit_price_cents / 100).toFixed(2));
                    }}
                  >
                    <option value="">Select service…</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}: {money(s.unit_price_cents)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-1">
                  <Label htmlFor="addon-qty" className="text-xs">
                    Qty
                  </Label>
                  <Input
                    id="addon-qty"
                    className="mt-0.5 h-9"
                    type="number"
                    min="1"
                    value={qty}
                    onChange={(e) => setQty(e.target.value)}
                  />
                </div>
                <div className="col-span-1">
                  <Label htmlFor="addon-price" className="text-xs">
                    Price ($)
                  </Label>
                  <Input
                    id="addon-price"
                    className="mt-0.5 h-9"
                    type="number"
                    step="0.01"
                    min="0"
                    value={priceOverride}
                    onChange={(e) => setPriceOverride(e.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="col-span-1"
                  disabled={chargeMut.isPending || !svcId}
                >
                  Add
                </Button>
              </form>
              <p className="mt-1 text-xs text-muted-foreground">
                Prepaid clients: debits credit balance immediately. Postpaid: added to next invoice.
              </p>
            </div>

            <div>
              <SectionLabel>Recurring add-on</SectionLabel>
              <form
                className="mt-2 grid grid-cols-6 items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  subMut.mutate();
                }}
              >
                <div className="col-span-3">
                  <Label htmlFor="addon-sub-svc" className="text-xs">
                    Service
                  </Label>
                  <select
                    id="addon-sub-svc"
                    className="mt-0.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={subSvcId}
                    onChange={(e) => {
                      setSubSvcId(e.target.value);
                      const s = services.find((x) => x.id === e.target.value);
                      if (s) setSubPrice((s.unit_price_cents / 100).toFixed(2));
                    }}
                  >
                    <option value="">Select service…</option>
                    {services.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="col-span-1">
                  <Label htmlFor="addon-sub-freq" className="text-xs">
                    Repeats
                  </Label>
                  <select
                    id="addon-sub-freq"
                    className="mt-0.5 h-9 w-full rounded-md border bg-background px-2 text-sm"
                    value={subFreq}
                    onChange={(e) => setSubFreq(e.target.value)}
                  >
                    <option value="weekly">Wk</option>
                    <option value="biweekly">Bi-wk</option>
                    <option value="monthly">Mo</option>
                    <option value="quarterly">Qtr</option>
                    <option value="yearly">Yr</option>
                  </select>
                </div>
                <div className="col-span-1">
                  <Label htmlFor="addon-sub-price" className="text-xs">
                    Price ($)
                  </Label>
                  <Input
                    id="addon-sub-price"
                    className="mt-0.5 h-9"
                    type="number"
                    step="0.01"
                    min="0"
                    value={subPrice}
                    onChange={(e) => setSubPrice(e.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  size="sm"
                  className="col-span-1"
                  disabled={subMut.isPending || !subSvcId}
                >
                  Start
                </Button>
              </form>
            </div>
          </div>
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => setShowAdd(false)}
          >
            <X className="h-3 w-3" /> Cancel
          </button>
        </div>
      )}

      {subs.length > 0 && (
        <div className="mt-6">
          <div className="text-xs font-medium text-muted-foreground">Active recurring add-ons</div>
          <ul className="mt-2 divide-y text-sm">
            {subs.map((s) => (
              <li key={s.id} className="flex items-center justify-between py-2">
                <span>
                  {s.addon_services?.name}: {money(s.price_cents)} · {s.frequency}
                  <span className="ml-2 text-xs text-muted-foreground">
                    next {formatDay(s.next_charge_on)}
                  </span>
                  {s.status !== "active" && <StatusChip status={s.status} className="ml-2" />}
                </span>
                <div className="flex gap-1">
                  {s.status === "active" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => statusMut.mutate({ id: s.id, status: "paused" })}
                    >
                      Pause
                    </Button>
                  ) : s.status === "paused" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => statusMut.mutate({ id: s.id, status: "active" })}
                    >
                      Resume
                    </Button>
                  ) : null}
                  {s.status !== "canceled" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => statusMut.mutate({ id: s.id, status: "canceled" })}
                    >
                      <X className="mr-1 h-3.5 w-3.5" /> Cancel
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {charges.some(
        (c) => c.source === "field" && c.status !== "invoiced" && c.status !== "voided",
      ) && (
        <div className="mt-6 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Field add-ons to review
          </div>
          <ul className="mt-2 divide-y text-sm">
            {charges
              .filter(
                (c) => c.source === "field" && c.status !== "invoiced" && c.status !== "voided",
              )
              .slice(0, 8)
              .map((c) => (
                <li key={c.id} className="flex items-center justify-between py-1.5">
                  <span>
                    <span className="text-muted-foreground">{formatDay(c.occurred_on)}</span>
                    <span className="ml-2">{c.description}</span>
                    {c.quantity > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">× {c.quantity}</span>
                    )}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-medium">{money(c.amount_cents)}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => voidMut.mutate(c.id)}
                      disabled={voidMut.isPending}
                    >
                      Void
                    </Button>
                  </span>
                </li>
              ))}
          </ul>
        </div>
      )}

      <div className="mt-6">
        <div className="text-xs font-medium text-muted-foreground">Recent charges</div>
        {charges.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No add-on charges yet.</p>
        ) : (
          <ul className="mt-2 divide-y text-sm">
            {charges.slice(0, 12).map((c) => (
              <li key={c.id} className="flex items-center justify-between py-2">
                <span>
                  <span className="text-muted-foreground">{formatDay(c.occurred_on)}</span>
                  <span className="ml-2">{c.description}</span>
                  {c.quantity > 1 && (
                    <span className="ml-1 text-xs text-muted-foreground">× {c.quantity}</span>
                  )}
                  <StatusChip status={c.status} className="ml-2" />
                  {c.source === "field" && <MetaChip className="ml-1">Field</MetaChip>}
                </span>
                <span className="flex items-center gap-2">
                  <span className="font-medium">{money(c.amount_cents)}</span>
                  {c.status !== "invoiced" && c.status !== "voided" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => voidMut.mutate(c.id)}
                      disabled={voidMut.isPending}
                    >
                      Void
                    </Button>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
