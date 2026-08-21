// Billing panels for the client detail page: invoice history + generation,
// autopay recovery, add-on services, and the inline prepay control. Moved
// verbatim from the route file during the client-detail refactor (Stage 2).
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Link } from "@tanstack/react-router";
import { FileText, MoreHorizontal, Plus, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
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
  resumeAutopay,
} from "@/lib/invoices.functions";
import { InvoiceDrawer } from "@/components/InvoiceDrawer";
import { InvoiceCard, InvoiceRow, type InvoiceRowData } from "@/components/InvoiceRow";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import { formatDay, surchargeSplit } from "@/lib/format";
import { humanizeEnum } from "@/lib/humanize";
import { addonBillingTrail } from "@/lib/addon-billing";
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
  const summaryFn = useServerFn(getClientBillingSummary);
  const genFn = useServerFn(generateInvoiceForClient);
  const [advancedOpen, setAdvancedOpen] = useState(false);

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
      if (r?.invoiceId) {
        toast.success("Invoice generated");
        invalidate();
      } else {
        toast.info(
          "Nothing to invoice yet. Invoices generate automatically on this client's cadence.",
        );
      }
      setAdvancedOpen(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const invoices = data?.invoices ?? [];
  const payments = data?.payments ?? [];
  const [detailInvoiceId, setDetailInvoiceId] = useState<string | null>(null);

  return (
    <>
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
          {/* Full auto billing: invoices generate nightly on the client's
              cadence, so manual generate-from-visits is a demoted fallback in
              an overflow dialog (mirrors the Invoices page). */}
          <Dialog open={advancedOpen} onOpenChange={setAdvancedOpen}>
            <DialogTrigger asChild>
              <Button variant="ghost" size="sm" aria-label="Advanced invoicing actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md">
              <DialogHeader>
                <DialogTitle>Generate from visits (manual fallback)</DialogTitle>
                <DialogDescription>
                  Invoices generate automatically on this client's cadence, so you normally never
                  need this. Use it to bill all unbilled completed visits through today right now,
                  for example before changing their cadence.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  variant="secondary"
                  onClick={() => genMut.mutate()}
                  disabled={genMut.isPending}
                >
                  {genMut.isPending ? "Generating…" : "Generate from visits"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>

        {invoices.length === 0 ? (
          <div className="mt-3">
            <EmptyState
              compact
              icon={FileText}
              title="No invoices yet"
              description="Invoices generate automatically when this client's billing cycle ends."
            />
          </div>
        ) : (
          <>
            {/* NATIVE ONLY — the table below is the web product's presentation
                and is untouched.
                Inside the binary these render as tap-through cards instead, the
                same InvoiceCard the Invoices page already uses below `md`. The
                table alone was never going to work on a phone: six columns
                inside `w-full` can never exceed their container, so
                `overflow-x-auto` never engages and the columns compress rather
                than scroll. iOS QA 2026-08-20 caught the Total column clipped
                to a bare "$" and "$1," on a 402pt iPhone — you could not read
                what an invoice was for. The same fault exists on mobile web and
                is deliberately left there for now: `main` deploys straight to
                app.houndstack.com and this pass was only ever about the phone.
                Worth revisiting with the PWA. */}
            {IS_NATIVE_BUNDLE && (
              <div className="mt-3 space-y-3 md:hidden">
                {invoices.map((inv: InvoiceRowData) => (
                  <InvoiceCard key={inv.id} invoice={inv} onOpen={setDetailInvoiceId} />
                ))}
              </div>
            )}
            <div className={`mt-3 overflow-x-auto ${IS_NATIVE_BUNDLE ? "max-md:hidden" : ""}`}>
              {/* Same invoice row + preview drawer as the Invoices page (B4/I3):
                click a row (or its View button) to open the shared drawer;
                the trailing ••• offers open-full-invoice / copy pay link,
                while stateful actions (take payment, send, void) stay in the
                drawer. */}
              <table className="w-full text-sm">
                <thead className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Invoice</th>
                    <th className="px-4 py-2 font-semibold">Period</th>
                    <th className="px-4 py-2 font-semibold">Due</th>
                    <th className="px-4 py-2 text-right font-semibold">Total</th>
                    <th className="px-4 py-2 font-semibold">Status</th>
                    <th className="w-24 px-4 py-2 text-right font-semibold">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv: any) => (
                    <InvoiceRow key={inv.id} invoice={inv} onOpen={setDetailInvoiceId} />
                  ))}
                </tbody>
              </table>
            </div>
          </>
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
                {(() => {
                  // The charged total, not the invoice amount. A $45.75
                  // invoice paid by card can be $47.13 on the customer's
                  // statement, and showing only the first number is how a
                  // "why is this different" call starts.
                  const split = surchargeSplit(p.amount_cents, p.surcharge_cents);
                  return (
                    <span className="text-right">
                      <span className="font-medium">
                        ${((split?.chargedCents ?? p.amount_cents) / 100).toFixed(2)}
                      </span>
                      {split && (
                        <span className="block text-2xs text-muted-foreground">
                          ${(split.baseCents / 100).toFixed(2)} service + $
                          {(split.feeCents / 100).toFixed(2)} card fee
                        </span>
                      )}
                    </span>
                  );
                })()}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Shared rich drawer (QA round 8): same surface as the invoices index. */}
      <InvoiceDrawer
        invoiceId={detailInvoiceId}
        onClose={() => setDetailInvoiceId(null)}
        onChanged={invalidate}
      />
    </>
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
  const { confirm: confirmAddon, dialog: addonConfirmDialog } = useConfirmDialog();
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
    onSuccess: (r, v) => {
      invalidate();
      if (v.status !== "active") {
        toast.success(v.status === "paused" ? "Add-on paused" : "Add-on canceled");
        return;
      }
      // Resuming used to be a silent status flip that also, invisibly,
      // handed the nightly job every period the plan sat paused. It now
      // skips them — and says so, because "we are not billing you for
      // November through February" is not something to leave implied.
      const skipped = Number(r?.skippedPeriods ?? 0);
      const next = r?.nextChargeOn ? formatDay(r.nextChargeOn) : null;
      toast.success(
        skipped > 0
          ? `Resumed. The ${skipped} billing period${skipped === 1 ? "" : "s"} it was paused for ${skipped === 1 ? "is" : "are"} skipped${next ? `; next charge ${next}` : ""}.`
          : `Resumed${next ? `. Next charge ${next}` : ""}.`,
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <section className="rounded-lg border bg-card shadow-sm p-5">
      {addonConfirmDialog}
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
                // Six columns at every width put the price box and the submit
                // button in one column each — about 37px at 360px, on a form
                // that charges a card. The add-credit form in BillingTab.tsx
                // already reflows exactly this way.
                className="mt-2 grid grid-cols-6 items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  chargeMut.mutate();
                }}
              >
                <div className="col-span-6 sm:col-span-3">
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
                <div className="col-span-3 sm:col-span-1">
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
                <div className="col-span-3 sm:col-span-1">
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
                  className="col-span-6 max-md:min-h-11 sm:col-span-1"
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
                // Six columns at every width put the price box and the submit
                // button in one column each — about 37px at 360px, on a form
                // that charges a card. The add-credit form in BillingTab.tsx
                // already reflows exactly this way.
                className="mt-2 grid grid-cols-6 items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  subMut.mutate();
                }}
              >
                <div className="col-span-6 sm:col-span-3">
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
                <div className="col-span-3 sm:col-span-1">
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
                <div className="col-span-3 sm:col-span-1">
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
                  className="col-span-6 max-md:min-h-11 sm:col-span-1"
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
                  {/* BUG-4: raw frequency enums ("per_visit") reached users. */}
                  {s.addon_services?.name}: {money(s.price_cents)} · {humanizeEnum(s.frequency)}
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
                      className="text-destructive hover:text-destructive"
                      onClick={async () => {
                        // Ends the recurring add-on, not a form dismiss:
                        // destructive styling + confirm, no X-icon dress.
                        if (
                          await confirmAddon({
                            title: "Cancel this add-on?",
                            description: `${s.addon_services?.name ?? "This add-on"} stops billing and won't be charged again. Past charges are kept.`,
                            confirmLabel: "Cancel add-on",
                            destructive: true,
                          })
                        )
                          statusMut.mutate({ id: s.id, status: "canceled" });
                      }}
                    >
                      Cancel add-on…
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
            {charges.slice(0, 12).map((c) => {
              // Where the charge ended up. "Invoiced" on its own has always
              // left whoever is on the phone with the client to go and find the
              // invoice by hand; the charge knew which line it became all along.
              const billing = addonBillingTrail(c);
              return (
                <li key={c.id} className="flex items-start justify-between py-2">
                  <span>
                    <span className="text-muted-foreground">{formatDay(c.occurred_on)}</span>
                    <span className="ml-2">{c.description}</span>
                    {c.quantity > 1 && (
                      <span className="ml-1 text-xs text-muted-foreground">× {c.quantity}</span>
                    )}
                    <StatusChip
                      status={c.status}
                      className="ml-2"
                      // 'pending' is billing-internal jargon: the charge is
                      // live and lands on the next invoice, nothing to accept.
                      label={c.status === "pending" ? "Unbilled, next invoice" : undefined}
                    />
                    {c.source === "field" && <MetaChip className="ml-1">Field</MetaChip>}
                    {/* Only when it says something the chip does not. The chip
                        already covers "unbilled" and "voided"; what it has never
                        been able to say is WHICH invoice a billed charge is on. */}
                    {(billing.invoiceId || billing.warning) && (
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {billing.invoiceId ? (
                          <Link
                            to="/invoices/$invoiceId"
                            params={{ invoiceId: billing.invoiceId }}
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {billing.label}
                          </Link>
                        ) : (
                          billing.label
                        )}
                        {billing.warning && (
                          <span className="ml-1 text-amber-600">{billing.warning}</span>
                        )}
                      </span>
                    )}
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
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
