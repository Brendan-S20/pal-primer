import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getBillingStatus,
  createBillingPortal,
  refreshBillingStatus,
  listPlatformInvoices,
  cancelBillingSubscription,
  resumeBillingSubscription,
  listSubscriptionItems,
} from "@/lib/billing.functions";
import { PlanPicker, EmbeddedPlanCheckout } from "@/components/billing/PlanPicker";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

// Moved into Settings (punch list #9): this is HoundStack's own subscription
// (the CRM plan), which is configuration - the tenant-facing Stripe money view
// now lives at /payments in the main sidebar.
export const Route = createFileRoute("/_authenticated/settings/billing")({
  component: BillingPage,
});

function formatUsd(cents: number | null | undefined) {
  if (cents == null) return "-";
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

const STATUS_LABEL: Record<string, string> = {
  free: "Free",
  trialing: "Free trial",
  active: "Active",
  past_due: "Past due",
  grace: "Grace period",
  canceled: "Canceled",
  suspended: "Suspended",
};
const STATUS_TONE: Record<string, "default" | "outline" | "destructive" | "secondary"> = {
  free: "outline",
  trialing: "secondary",
  active: "default",
  past_due: "destructive",
  grace: "secondary",
  canceled: "outline",
  suspended: "destructive",
};

function BillingPage() {
  const qc = useQueryClient();
  const statusFn = useServerFn(getBillingStatus);
  const portalFn = useServerFn(createBillingPortal);
  const refreshFn = useServerFn(refreshBillingStatus);

  const { data, isLoading } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => statusFn(),
  });

  const [checkoutPlanId, setCheckoutPlanId] = useState<string | null>(null);
  const cancelFn = useServerFn(cancelBillingSubscription);
  const resumeFn = useServerFn(resumeBillingSubscription);
  const cancelSub = useMutation({
    mutationFn: () => cancelFn(),
    onSuccess: (r: any) => {
      toast.success(r.endsAt
        ? `Subscription will end ${new Date(r.endsAt).toLocaleDateString()}. Access continues until then`
        : "Subscription set to cancel at period end");
      qc.invalidateQueries({ queryKey: ["billing-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resumeSub = useMutation({
    mutationFn: () => resumeFn(),
    onSuccess: () => { toast.success("Subscription resumed"); qc.invalidateQueries({ queryKey: ["billing-status"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const portal = useMutation({
    mutationFn: () => portalFn({ data: { returnUrl: window.location.href } }),
    onSuccess: (r) => {
      if (r.url) window.location.href = r.url;
      else toast.error("No portal URL returned");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const refresh = useMutation({
    mutationFn: () => refreshFn(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-status"] });
      toast.success("Refreshed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground">Manage your subscription to the CRM.</p>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">Current plan</p>
            <div className="mt-1 flex items-center gap-2">
              <p className="text-xl font-semibold">{data.planName}</p>
              <Badge variant={STATUS_TONE[data.billingStatus] ?? "outline"}>
                {STATUS_LABEL[data.billingStatus] ?? data.billingStatus}
              </Badge>
            </div>
            {data.monthlyEstimateCents != null && (
              <p className="mt-1 text-sm text-muted-foreground">
                {formatUsd(data.monthlyEstimateCents)}/mo · Unlimited customers
              </p>
            )}
            {data.billingStatus === "trialing" && (
              <p className="mt-2 text-sm text-amber-700">
                You're on a free trial. Add a plan before it ends to keep full access.
              </p>
            )}
            {data.billingStatus === "past_due" && (
              <p className="mt-2 text-sm text-destructive">
                Payment past due. Update your card in the customer portal.
              </p>
            )}
            {data.currentPeriodEnd && data.isPaidTier && (
              <p className="mt-1 text-xs text-muted-foreground">
                Renews {new Date(data.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">Active clients</p>
            {/* Customers are unlimited on every plan — no enforced client cap
                (finding #23; the old "16 / 3" contradicted the plan copy). */}
            <p className="text-xl font-semibold">{data.activeClientCount}</p>
          </div>
        </div>
      </div>

      {/* Embedded plan management: pick, pay, cancel — all in-app, no trip to
          checkout.stripe.com (Brendan's re-review). */}
      {checkoutPlanId ? (
        <EmbeddedPlanCheckout
          planId={checkoutPlanId}
          returnUrl={typeof window !== "undefined" ? window.location.href.split("?")[0] : "https://app.houndstack.com/settings/billing"}
          onCancel={() => setCheckoutPlanId(null)}
        />
      ) : (
        <div className="space-y-3">
          <div>
            <h2 className="text-lg font-semibold">
              {data.isPaidTier ? "Plans" : data.billingStatus === "trialing" ? "You're on a free trial: pick a plan" : "Choose a plan"}
            </h2>
            <p className="text-sm text-muted-foreground">
              Unlimited customers, dogs, jobs, routes, and zones on every tier. You're billed per employee.
            </p>
          </div>
          <PlanPicker
            currentSlug={data.planSlug}
            onSelect={(planId) => setCheckoutPlanId(planId)}
            chooseLabel={data.isPaidTier ? "Switch to this plan" : "Choose plan"}
          />
        </div>
      )}

      {data.isPaidTier && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">Manage subscription</h2>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              onClick={() => {
                if (confirm("Cancel your subscription? You keep access until the end of the paid period.")) {
                  cancelSub.mutate();
                }
              }}
              disabled={cancelSub.isPending}
            >
              {cancelSub.isPending ? "Canceling…" : "Cancel subscription"}
            </Button>
            <Button variant="ghost" onClick={() => resumeSub.mutate()} disabled={resumeSub.isPending}>
              {resumeSub.isPending ? "Resuming…" : "Resume (undo cancel)"}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Need to change the card on file?{" "}
            <button className="underline" onClick={() => portal.mutate()} disabled={portal.isPending}>
              {portal.isPending ? "Opening…" : "Update payment method"}
            </button>
          </p>
        </div>
      )}

      {data.isPaidTier && <SubscriptionItems onOpenPortal={() => portal.mutate()} portalPending={portal.isPending} />}

      <InvoiceHistory />

      <div className="rounded-lg border bg-card p-4">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            Just paid or updated? Refresh to pull the latest status from Stripe.
          </p>
          <Button variant="outline" size="sm" onClick={() => refresh.mutate()} disabled={refresh.isPending}>
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// In-app billing history (punch list #10) — no portal round-trip needed just
// to see or download an invoice.
function InvoiceHistory() {
  const listFn = useServerFn(listPlatformInvoices);
  const { data, isLoading } = useQuery({
    queryKey: ["platform-invoices"],
    queryFn: () => listFn(),
  });
  const invoices: any[] = (data as any)?.invoices ?? [];

  return (
    <div className="rounded-lg border bg-card p-6">
      <h2 className="text-lg font-semibold">Billing history</h2>
      {isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      ) : invoices.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No invoices yet. Your subscription invoices will appear here once you're billed.
        </p>
      ) : (
        <table className="mt-3 w-full text-sm">
          <thead className="text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="py-1.5">Invoice</th>
              <th className="py-1.5">Period</th>
              <th className="py-1.5">Amount</th>
              <th className="py-1.5">Status</th>
              <th className="py-1.5 text-right">Links</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {invoices.map((inv) => (
              <tr key={inv.stripe_invoice_id}>
                <td className="py-2 font-medium">{inv.number ?? inv.stripe_invoice_id.slice(0, 12)}</td>
                <td className="py-2 text-muted-foreground">
                  {inv.period_start ? new Date(inv.period_start).toLocaleDateString() : "-"}
                  {inv.period_end ? ` - ${new Date(inv.period_end).toLocaleDateString()}` : ""}
                </td>
                <td className="py-2">{formatUsd(inv.amount_due_cents)}</td>
                <td className="py-2">
                  <Badge variant={inv.status === "paid" ? "default" : inv.status === "open" ? "secondary" : "outline"}>
                    {inv.status}
                  </Badge>
                </td>
                <td className="py-2 text-right">
                  {inv.hosted_invoice_url && (
                    <a href={inv.hosted_invoice_url} target="_blank" rel="noreferrer" className="text-primary underline">View</a>
                  )}
                  {inv.invoice_pdf && (
                    <a href={inv.invoice_pdf} target="_blank" rel="noreferrer" className="ml-3 text-primary underline">PDF</a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// Line-item breakdown of the Stripe subscription: base plan + seat overage +
// any bolt-on add-ons. Surfaces the full bill inline so owners don't need to
// open the Stripe customer portal just to see what they're paying for.
function SubscriptionItems({ onOpenPortal, portalPending }: { onOpenPortal: () => void; portalPending: boolean }) {
  const listFn = useServerFn(listSubscriptionItems);
  const { data, isLoading } = useQuery({
    queryKey: ["billing-subscription-items"],
    queryFn: () => listFn(),
  });
  const items: any[] = (data as any)?.items ?? [];
  const addons = items.filter((i) => i.kind === "addon");
  const base = items.filter((i) => i.kind !== "addon");

  const fmtLine = (i: any) => {
    if (i.unitAmountCents == null) return "-";
    const per = formatUsd(i.unitAmountCents);
    const total = formatUsd(i.unitAmountCents * (i.quantity ?? 1));
    const interval = i.interval ? `/${i.intervalCount > 1 ? `${i.intervalCount} ` : ""}${i.interval}` : "";
    return i.quantity > 1
      ? `${i.quantity} × ${per}${interval} · ${total}${interval}`
      : `${per}${interval}`;
  };

  return (
    <div className="rounded-lg border bg-card p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">What you're paying for</h2>
        {addons.length > 0 && (
          <Badge variant="secondary">{addons.length} add-on{addons.length === 1 ? "" : "s"}</Badge>
        )}
      </div>
      {isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      ) : items.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No active subscription line items to show.
        </p>
      ) : (
        <ul className="mt-3 divide-y">
          {[...base, ...addons].map((i) => (
            <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="font-medium">{i.name}</p>
                  {i.kind === "base" && <Badge variant="outline">Plan</Badge>}
                  {i.kind === "seat" && <Badge variant="outline">Seat overage</Badge>}
                  {i.kind === "addon" && <Badge>Add-on</Badge>}
                </div>
                {i.description && (
                  <p className="text-xs text-muted-foreground">{i.description}</p>
                )}
              </div>
              <p className="text-sm text-right whitespace-nowrap">{fmtLine(i)}</p>
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && addons.length === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          No add-ons on your plan. Extra add-ons can be attached to your subscription from the{" "}
          <button
            type="button"
            onClick={onOpenPortal}
            disabled={portalPending}
            className="underline"
          >
            {portalPending ? "Opening…" : "customer portal"}
          </button>.
        </p>
      )}
    </div>
  );
}
