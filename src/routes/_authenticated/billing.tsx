import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getBillingStatus,
  createBillingCheckout,
  createBillingPortal,
  refreshBillingStatus,
} from "@/lib/billing.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/billing")({
  component: BillingPage,
});

function formatUsd(cents: number | null | undefined) {
  if (cents == null) return "—";
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

const STATUS_LABEL: Record<string, string> = {
  free: "Free",
  active: "Active",
  past_due: "Past due",
  grace: "Grace period",
  canceled: "Canceled",
  suspended: "Suspended",
};
const STATUS_TONE: Record<string, "default" | "outline" | "destructive" | "secondary"> = {
  free: "outline",
  active: "default",
  past_due: "destructive",
  grace: "secondary",
  canceled: "outline",
  suspended: "destructive",
};

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
    onSuccess: (r) => {
      if (r.url) window.location.href = r.url;
      else toast.error("No checkout URL returned");
    },
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

  const bandLabel = (() => {
    const min = data.requiredPlanBandMin ?? 0;
    const max = data.requiredPlanBandMax;
    if (max == null) return `${min}+ clients`;
    return `${min}–${max} clients`;
  })();

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
                {formatUsd(data.monthlyEstimateCents)}/mo · {bandLabel}
              </p>
            )}
            {data.billingStatus === "past_due" && (
              <p className="mt-2 text-sm text-destructive">
                Payment past due — update your card in the customer portal.
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
            <p className="text-xl font-semibold">
              {data.activeClientCount}
              {!data.isPaidTier && (
                <span className="text-muted-foreground"> / {data.freeLimit}</span>
              )}
            </p>
          </div>
        </div>
      </div>

      {data.needsUpgrade && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">
            {data.requiredPlanName ?? "Upgrade required"}
            {data.monthlyEstimateCents != null && ` — ${formatUsd(data.monthlyEstimateCents)}/mo`}
          </h2>
          <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
            <li>• Covers {bandLabel}</li>
            <li>• Unlimited staff on every tier</li>
            <li>• Cancel anytime from the customer portal</li>
          </ul>
          <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            You have {data.activeClientCount} active clients — above the current plan limit. Upgrade to keep adding.
          </p>
          <Button className="mt-4" onClick={() => checkout.mutate()} disabled={checkout.isPending}>
            {checkout.isPending ? "Redirecting…" : `Upgrade to ${data.requiredPlanName ?? "paid plan"}`}
          </Button>
        </div>
      )}

      {data.isPaidTier && (
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

      {!data.isPaidTier && !data.needsUpgrade && (
        <div className="rounded-lg border bg-card p-6">
          <h2 className="text-lg font-semibold">You're on the free plan</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            First {data.freeLimit} active clients are on us. You'll be prompted to upgrade
            when you cross that threshold.
          </p>
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
