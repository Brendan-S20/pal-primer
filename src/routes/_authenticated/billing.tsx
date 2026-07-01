import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getBillingStatus,
  createBillingCheckout,
  createBillingPortal,
  refreshBillingStatus,
  PRO_PRICE_CENTS,
} from "@/lib/billing.functions";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/billing")({
  component: BillingPage,
});

function formatUsd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function BillingPage() {
  const qc = useQueryClient();
  const statusFn = useServerFn(getBillingStatus);
  const checkoutFn = useServerFn(createBillingCheckout);
  const portalFn = useServerFn(createBillingPortal);
  const refreshFn = useServerFn(refreshBillingStatus);

  const { data, isLoading } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => statusFn(),
  });

  const checkout = useMutation({
    mutationFn: () => checkoutFn({ data: { returnUrl: window.location.href } }),
    onSuccess: (r) => { if (r.url) window.location.href = r.url; },
    onError: (e: Error) => toast.error(e.message),
  });
  const portal = useMutation({
    mutationFn: () => portalFn({ data: { returnUrl: window.location.href } }),
    onSuccess: (r) => { if (r.url) window.location.href = r.url; },
    onError: (e: Error) => toast.error(e.message),
  });
  const refresh = useMutation({
    mutationFn: () => refreshFn(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["billing-status"] }); toast.success("Refreshed"); },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading || !data) return <p className="text-muted-foreground">Loading…</p>;

  const overLimit = data.activeClientCount > data.freeLimit;
  const atLimit = data.activeClientCount >= data.freeLimit;
  const isPaid = data.planStatus === "active" || data.planStatus === "past_due";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing</h1>
        <p className="text-sm text-muted-foreground">Manage your subscription to the CRM.</p>
      </div>

      <div className="rounded-lg border bg-card p-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">Current plan</p>
            <p className="text-xl font-semibold capitalize">
              {isPaid ? "Pro" : data.planStatus === "canceled" ? "Free (canceled)" : "Free"}
            </p>
            {data.planStatus === "past_due" && (
              <p className="mt-1 text-sm text-destructive">Payment past due — update your card in the portal.</p>
            )}
            {data.currentPeriodEnd && isPaid && (
              <p className="mt-1 text-xs text-muted-foreground">
                Renews {new Date(data.currentPeriodEnd).toLocaleDateString()}
              </p>
            )}
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">Active clients</p>
            <p className="text-xl font-semibold">
              {data.activeClientCount}
              {!isPaid && <span className="text-muted-foreground"> / {data.freeLimit}</span>}
            </p>
          </div>
        </div>
      </div>

      {!isPaid && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">Pro — {formatUsd(PRO_PRICE_CENTS)}/mo</h2>
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            <li>• Unlimited active clients</li>
            <li>• Required once you exceed {data.freeLimit} active clients</li>
            <li>• Cancel anytime from the customer portal</li>
          </ul>
          {atLimit && (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {overLimit
                ? `You have ${data.activeClientCount} active clients but the free plan allows ${data.freeLimit}. Upgrade to keep adding.`
                : `You have reached the ${data.freeLimit}-client free limit. Upgrade to add more.`}
            </p>
          )}
          <Button className="mt-4" onClick={() => checkout.mutate()} disabled={checkout.isPending}>
            {checkout.isPending ? "Redirecting…" : "Upgrade to Pro"}
          </Button>
        </div>
      )}

      {isPaid && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">Manage subscription</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Update payment method, download invoices, or cancel via the Stripe customer portal.
          </p>
          <Button className="mt-4" onClick={() => portal.mutate()} disabled={portal.isPending}>
            {portal.isPending ? "Opening…" : "Open customer portal"}
          </Button>
        </div>
      )}

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
