import { useLaunchCopy } from "@/lib/launch-copy";
import { createFileRoute } from "@tanstack/react-router";
import { LoadError } from "@/components/LoadError";
import { LineBones } from "@/components/PageSkeletons";
import { nextInvoiceTotalCents } from "@/lib/next-invoice-total";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import {
  getBillingStatus,
  refreshBillingStatus,
  listPlatformInvoices,
  cancelBillingSubscription,
  resumeBillingSubscription,
  listSubscriptionItems,
  createPlanSubscription,
  listOrgPaymentMethods,
  createOrgSetupIntent,
  finalizeOrgPaymentMethod,
  setDefaultOrgPaymentMethod,
  removeOrgPaymentMethod,
} from "@/lib/billing.functions";
import {
  PlanPicker,
  EmbeddedPlanCheckout,
  getPlatformStripe,
  type BillingInterval,
} from "@/components/billing/PlanPicker";
import {
  listPlatformAddons,
  subscribePlatformAddon,
  cancelPlatformAddon,
} from "@/lib/platform-addons.functions";
import { isSetupAddon, setupIsFreeFor, SETUP_FREE_BECAUSE } from "@/lib/done-for-you-setup";
import { addonCardState, HELD_ADDON_ON_PLAN, managedTextingCard } from "@/lib/addon-launch";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusChip, MetaChip, SectionLabel } from "@/components/client-detail/primitives";
import { formatDay } from "@/lib/format";
import { stripeAppearance } from "@/lib/stripe-appearance";
import { platform } from "@/lib/native";
import { saasPurchaseAllowed, BILLING_MANAGED_OUTSIDE_APP } from "@/lib/app-store-billing";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { toast } from "sonner";
import { appUrl } from "@/lib/app-origin";
import { titleHead } from "@/lib/page-title";
import { ExportDataCard } from "@/components/billing/ExportDataCard";

// Moved into Settings (punch list #9): this is HoundStack's own subscription
// (the CRM plan), which is configuration - the tenant-facing Stripe money view
// now lives at /payments in the main sidebar.
export const Route = createFileRoute("/_authenticated/settings/billing")({
  head: () => titleHead("Plan & billing", "Settings"),
  component: BillingPage,
});

// minimumFractionDigits was 0, which drops the second decimal on every amount
// whose cents end in a zero: 4310 rendered "$43.1", 12990 "$129.9", 10 "$0.1",
// and 5900 "$59". These are real Stripe amounts -- a mid-cycle plan change
// produces arbitrary prorated cents -- shown in billing history, in refund
// rows, and inside the confirm dialog that asks the owner to agree to a
// one-time charge. Roughly one prorated amount in ten lands on a zero cent.
//
// Two decimals always, because this is the tenant's own money and a price with
// one decimal reads as a typo rather than a total.
function formatUsd(cents: number | null | undefined) {
  if (cents == null) return "-";
  return `$${(cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// A subscription invoice whose period_start and period_end land on the same day
// rendered a nonsense "Thu, Jul 16 to Thu, Jul 16" range (C9). Show a single
// date when the two coincide (or one is missing), and the true range otherwise.
function formatBillingPeriod(start: string | null | undefined, end: string | null | undefined) {
  if (!start && !end) return "-";
  if (!end) return formatDay(start!);
  if (!start) return formatDay(end);
  const sameDay = new Date(start).toDateString() === new Date(end).toDateString();
  return sameDay ? formatDay(start) : `${formatDay(start)} to ${formatDay(end)}`;
}

function futureSubscriptionPeriodEnd(
  subscription: { subscriptionId: string | null; currentPeriodEnd: string | null } | undefined,
) {
  const end = subscription?.currentPeriodEnd;
  return subscription?.subscriptionId && end && new Date(end).getTime() > Date.now()
    ? end
    : null;
}

// Map billing statuses onto the shared StatusChip tones.
const STATUS_CHIP: Record<string, { status: string; label: string }> = {
  free: { status: "inactive", label: "Free" },
  trialing: { status: "open", label: "Free trial" },
  active: { status: "active", label: "Active" },
  past_due: { status: "overdue", label: "Past due" },
  grace: { status: "warning", label: "Grace period" },
  canceled: { status: "canceled", label: "Canceled" },
  suspended: { status: "failed", label: "Suspended" },
};

// A trialing org past trial_ends_at (#848). Not "Free trial": the lock banner
// above this page already says the trial has ended.
const TRIAL_ENDED_CHIP = { status: "overdue", label: "Trial ended" };

function BillingPage() {
  // Read once per render rather than memoised: Capacitor.getPlatform() is a
  // synchronous string lookup, and a stale memo here would be a store-policy
  // gate that silently stopped applying.
  const canBuySaas = saasPurchaseAllowed(platform());
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const statusFn = useServerFn(getBillingStatus);
  const refreshFn = useServerFn(refreshBillingStatus);
  const itemsFn = useServerFn(listSubscriptionItems);
  const createSubFn = useServerFn(createPlanSubscription);

  const { data, isLoading } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => statusFn(),
  });
  const {
    data: subInfo,
    isLoading: subInfoLoading,
    isError: subInfoError,
    refetch: refetchSubInfo,
  } = useQuery({
    queryKey: ["billing-subscription-items"],
    queryFn: () => itemsFn(),
    enabled: !!data?.isPaidTier,
  });

  const invalidateBilling = () => {
    qc.invalidateQueries({ queryKey: ["billing-status"] });
    qc.invalidateQueries({ queryKey: ["billing-subscription-items"] });
    qc.invalidateQueries({ queryKey: ["platform-addons"] });
    qc.invalidateQueries({ queryKey: ["platform-invoices"] });
  };

  // Self-heal quietly on mount: pull the real subscription state (status,
  // period end, plan identity from the sub's metadata) from Stripe once, then
  // refetch. No spinner takeover - the cached page renders immediately.
  const didAutoRefresh = useRef(false);
  useEffect(() => {
    if (didAutoRefresh.current) return;
    didAutoRefresh.current = true;
    refreshFn()
      .then(() => invalidateBilling())
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [checkout, setCheckout] = useState<{ planId: string; interval: BillingInterval } | null>(
    null,
  );
  const cancelFn = useServerFn(cancelBillingSubscription);
  const resumeFn = useServerFn(resumeBillingSubscription);
  const cancelSub = useMutation({
    mutationFn: () => cancelFn(),
    onSuccess: (r: any) => {
      toast.success(
        r.endsAt
          ? `Subscription will end ${formatDay(r.endsAt)}. Access continues until then`
          : "Subscription set to cancel at period end",
      );
      invalidateBilling();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const resumeSub = useMutation({
    mutationFn: () => resumeFn(),
    onSuccess: () => {
      toast.success("Subscription resumed");
      invalidateBilling();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const refresh = useMutation({
    mutationFn: () => refreshFn(),
    onSuccess: () => {
      invalidateBilling();
      toast.success("Billing status refreshed");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // In-place plan switch for orgs that already pay: no payment form, the
  // existing subscription is updated with proration. The selected card shows
  // "Switching…" immediately and the Current plan marker moves on success.
  const switchPlan = useMutation({
    mutationFn: (vars: { planId: string; planName: string; interval: BillingInterval }) =>
      createSubFn({ data: { planId: vars.planId, interval: vars.interval } }),
    onSuccess: (r: any, vars) => {
      if (r.switched) {
        if (r.chargeFailed) {
          toast.warning(
            "Plan switched. We couldn't charge the difference automatically; it will be retried.",
          );
        } else {
          toast.success(`Plan switched to ${r.planName}`);
        }
        invalidateBilling();
      } else {
        // No live subscription after all (e.g. it lapsed on Stripe's side):
        // fall into the normal payment form for the chosen plan.
        setCheckout({ planId: vars.planId, interval: vars.interval });
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const currentInterval: BillingInterval | null = (subInfo as any)?.planInterval ?? null;

  const onPickPlan = async (planId: string, planName: string, interval: BillingInterval) => {
    if (data?.isPaidTier) {
      const intervalChanged = !!currentInterval && interval !== currentInterval;
      const copy = intervalChanged
        ? interval === "year"
          ? {
              title: "Switch to annual billing?",
              description: "You'll be charged the prorated difference today.",
            }
          : {
              title: "Switch to monthly billing?",
              description:
                "Your plan changes right away. Unused time is credited to your next invoice.",
            }
        : {
            title: `Switch to ${planName}?`,
            description:
              "The change applies right away. If the new plan costs more, the prorated difference is charged to your card today; if it costs less, the difference is credited to your next invoice.",
          };
      const ok = await confirm({ ...copy, confirmLabel: "Switch plan" });
      if (ok) switchPlan.mutate({ planId, planName, interval });
    } else {
      setCheckout({ planId, interval });
    }
  };

  if (isLoading || !data) return <p className="text-muted-foreground">Loading…</p>;

  // plan_status stays 'trialing' after trial_ends_at passes, by design. Whether
  // the trial is still running is the phase trialStateFor derives on the
  // server, the same answer the account lock reads (#848). No second clock.
  const trialEnded = data.billingStatus === "trialing" && data.trialPhase === "expired";
  const chip = trialEnded
    ? TRIAL_ENDED_CHIP
    : (STATUS_CHIP[data.billingStatus] ?? { status: "inactive", label: data.billingStatus });
  const cancelPending = !!(subInfo as any)?.cancelAtPeriodEnd;
  // A saved org date can outlive its subscription. Only show a future date
  // returned by Stripe for an actual subscription, including during refresh.
  const periodEnd = futureSubscriptionPeriodEnd(subInfo);
  // Annual orgs: the plan card shows the real yearly amount from the
  // subscription's base item instead of the catalog's monthly price.
  const baseItem = ((subInfo as any)?.items ?? []).find((i: any) => i.kind === "base");
  const annualBaseCents =
    currentInterval === "year" && baseItem?.unitAmountCents != null
      ? baseItem.unitAmountCents * (baseItem.quantity ?? 1)
      : null;

  return (
    <div className="space-y-6">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Plan &amp; billing</h2>
          <p className="text-sm text-muted-foreground">
            Your HoundStack subscription: plan, add-ons, and invoices.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          {refresh.isPending ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {/* ── Current plan ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
        <SectionLabel>Current plan</SectionLabel>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-2xl font-semibold">{data.planName}</p>
              <StatusChip status={chip.status} label={chip.label} />
              {cancelPending && <MetaChip>Cancels at period end</MetaChip>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {annualBaseCents != null
                ? `${formatUsd(annualBaseCents)}/year`
                : data.monthlyEstimateCents != null
                  ? `${formatUsd(data.monthlyEstimateCents)}/month`
                  : "No charge"}
              {data.teamSizeRange && ` · For teams of ${data.teamSizeRange}`}
              {data.includedSeats != null &&
                ` · Includes ${data.includedSeats} employee${data.includedSeats === 1 ? "" : "s"}`}
            </p>
            {data.isPaidTier && periodEnd && (
              <p className="mt-1 text-sm text-muted-foreground">
                {cancelPending
                  ? `Cancels ${formatDay(periodEnd)}. You keep access until then.`
                  : `Renews ${formatDay(periodEnd)}`}
              </p>
            )}
            {data.billingStatus === "trialing" && (
              <p className="mt-2 text-sm text-amber-700">
                {trialEnded
                  ? canBuySaas
                    ? "Your free trial has ended and your account is locked. Choose a plan below to open it again."
                    : // Native: the STATUS stays, the steer goes.
                      "Your free trial has ended and your account is locked. Plan changes are handled outside the mobile app."
                  : canBuySaas
                    ? "You're on a free trial. Pick a plan below before it ends to keep full access."
                    : // Native: the STATUS stays, the steer goes. No domain, and
                      // no verb that reads as a purchase instruction.
                      "Your trial status is shown here. Plan changes are handled outside the mobile app."}
              </p>
            )}
            {data.billingStatus === "past_due" && (
              <p className="mt-2 text-sm text-destructive">
                {canBuySaas
                  ? "Your last payment failed. Update your payment method below to keep your plan."
                  : // The failure is a fact about the account and stays. Where
                    // to fix it does not get named.
                    "Your last payment failed. Payment method updates are handled outside the mobile app."}
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── Plans ────────────────────────────────────────────────────────── */}
      <section className="space-y-3">
        <div>
          {/* "Choose a plan" is an instruction to buy, and in a store build
              there is nothing below it to choose from. A store build gets the
              neutral heading whatever tier the account is on. */}
          <h2 className="text-lg font-semibold">
            {!canBuySaas || data.isPaidTier ? "Plans" : "Choose a plan"}
          </h2>
          <p className="text-sm text-muted-foreground">
            Unlimited clients, dogs, visits, routes, and zones on every tier. You're billed per
            employee, and every charge is shown before it is made.
            {canBuySaas &&
              data.isPaidTier &&
              " Switching is instant: upgrades charge the prorated difference today, downgrades credit your next invoice."}
          </p>
        </div>
        {!canBuySaas ? (
          // App Review: no way to buy or change a HoundStack plan inside the
          // binary. See src/lib/app-store-billing.ts for which side of the
          // line this sits on and why the tenant's own payment surfaces are
          // deliberately untouched.
          <div className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">
            {BILLING_MANAGED_OUTSIDE_APP}
          </div>
        ) : checkout ? (
          <EmbeddedPlanCheckout
            planId={checkout.planId}
            interval={checkout.interval}
            returnUrl={
              typeof window !== "undefined"
                ? window.location.href.split("?")[0]
                : appUrl("/settings/billing")
            }
            onCancel={() => setCheckout(null)}
            onSwitched={() => {
              setCheckout(null);
              invalidateBilling();
            }}
          />
        ) : (
          <PlanPicker
            currentSlug={data.planSlug}
            currentInterval={currentInterval}
            paid={!!data.isPaidTier}
            onSelect={onPickPlan}
            switchingPlanId={switchPlan.isPending ? switchPlan.variables?.planId : null}
            chooseLabel={data.isPaidTier ? "Switch to this plan" : "Choose plan"}
          />
        )}
      </section>

      {canBuySaas && data.isPaidTier && <PaymentMethodsCard />}

      {canBuySaas && <PlatformAddonsSection planInterval={currentInterval} />}

      {data.isPaidTier && (
        <NextInvoice
          subInfo={subInfo as any}
          isLoading={subInfoLoading}
          isError={subInfoError}
          onRetry={() => refetchSubInfo()}
        />
      )}

      <InvoiceHistory />

      <ExportDataCard />

      {/* ── Manage ───────────────────────────────────────────────────────── */}
      {/* Behind the store gate with the rest of it. Cancel and Resume CHANGE a
          HoundStack subscription from inside the binary, which is the thing
          app-store-billing.ts draws the line at — Resume especially, since it
          restarts a paid plan. Nothing is hidden by this: the Current plan card
          above still shows the "Cancels at period end" badge and the date, and
          read-only account status is exactly what that file says to keep. */}
      {canBuySaas && data.isPaidTier && (
        <section className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
          <h2 className="text-lg font-semibold">Manage subscription</h2>
          {cancelPending ? (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Your subscription is set to cancel
                {periodEnd ? ` on ${formatDay(periodEnd)}` : " at the end of the paid period"}.
                Resume it to keep your plan.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={() => resumeSub.mutate()}
                disabled={resumeSub.isPending}
              >
                {resumeSub.isPending ? "Resuming…" : "Resume subscription"}
              </Button>
            </>
          ) : (
            <>
              <p className="mt-1 text-sm text-muted-foreground">
                Canceling stops future charges. You keep access until the end of the paid period.
                Yearly plans aren't refunded. You can export your data for 30 days after canceling.
              </p>
              <Button
                className="mt-3"
                variant="outline"
                onClick={async () => {
                  if (
                    await confirm({
                      title: "Cancel your subscription?",
                      description: "You keep access until the end of the paid period.",
                      destructive: true,
                      confirmLabel: "Cancel subscription",
                    })
                  ) {
                    cancelSub.mutate();
                  }
                }}
                disabled={cancelSub.isPending}
              >
                {cancelSub.isPending ? "Canceling…" : "Cancel subscription"}
              </Button>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// In-app payment methods for the org's subscription (replaces the hosted
// billing portal round-trip): list cards, set the default, remove, and add a
// new card inline via a SetupIntent + Payment Element.
function PaymentMethodsCard() {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listOrgPaymentMethods);
  const setDefaultFn = useServerFn(setDefaultOrgPaymentMethod);
  const removeFn = useServerFn(removeOrgPaymentMethod);
  const [adding, setAdding] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["org-payment-methods"],
    queryFn: () => listFn(),
  });
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["org-payment-methods"] });
    qc.invalidateQueries({ queryKey: ["billing-status"] });
  };

  const makeDefault = useMutation({
    mutationFn: (paymentMethodId: string) => setDefaultFn({ data: { paymentMethodId } }),
    onSuccess: () => {
      toast.success("Default card updated");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const remove = useMutation({
    mutationFn: (paymentMethodId: string) => removeFn({ data: { paymentMethodId } }),
    onSuccess: () => {
      toast.success("Card removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const methods = data?.methods ?? [];
  const brandLabel = (b: string) => (b ? b.charAt(0).toUpperCase() + b.slice(1) : "Card");

  return (
    <section className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Payment methods</h2>
          <p className="text-sm text-muted-foreground">
            The default card pays your subscription. Payments are processed securely.
          </p>
        </div>
        {!adding && (
          <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
            Add card
          </Button>
        )}
      </div>
      {isLoading ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : methods.length === 0 && !adding ? (
        <p className="mt-3 text-sm text-muted-foreground">
          No saved cards yet. Add one so your subscription can renew.
        </p>
      ) : (
        <ul className="mt-3 divide-y">
          {methods.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div className="flex items-center gap-2">
                <p className="font-medium">
                  {brandLabel(m.brand)} ****{m.last4}
                </p>
                <span className="text-xs text-muted-foreground">
                  Expires {String(m.expMonth).padStart(2, "0")}/{String(m.expYear).slice(-2)}
                </span>
                {m.isDefault && <MetaChip>Default</MetaChip>}
              </div>
              <div className="flex items-center gap-2">
                {!m.isDefault && (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={makeDefault.isPending}
                    onClick={() => makeDefault.mutate(m.id)}
                  >
                    Set as default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (
                      await confirm({
                        title: `Remove ${brandLabel(m.brand)} ****${m.last4}?`,
                        destructive: true,
                        confirmLabel: "Remove card",
                      })
                    ) {
                      remove.mutate(m.id);
                    }
                  }}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {adding && (
        <div className="mt-4">
          <OrgCardSetup
            onDone={() => {
              setAdding(false);
              invalidate();
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}
    </section>
  );
}

// Inline card save for the org's platform billing customer: SetupIntent +
// Payment Element, then a server-side finalize that verifies the intent and
// promotes the card to the customer AND subscription default.
function OrgCardSetup({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const setupFn = useServerFn(createOrgSetupIntent);
  const q = useQuery({
    queryKey: ["org-setup-intent"],
    queryFn: () => setupFn(),
    retry: false,
    staleTime: 5 * 60 * 1000,
    gcTime: 0,
  });

  if (q.isLoading)
    return <p className="text-sm text-muted-foreground">Loading secure card form…</p>;
  if (q.error) return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  if (!q.data) return null;

  return (
    <div className="rounded-md border bg-background p-4">
      <Elements
        stripe={getPlatformStripe(q.data.publishableKey)}
        options={{ clientSecret: q.data.clientSecret, appearance: stripeAppearance() }}
      >
        <OrgCardSetupInner onDone={onDone} onCancel={onCancel} />
      </Elements>
    </div>
  );
}

function OrgCardSetupInner({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const finalizeFn = useServerFn(finalizeOrgPaymentMethod);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!stripe || !elements) return;
    setBusy(true);
    try {
      const { error, setupIntent } = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: window.location.href },
        redirect: "if_required",
      });
      if (error) {
        toast.error(error.message ?? "Couldn't save the card");
        return;
      }
      if (!setupIntent?.id) {
        toast.error("Card wasn't saved. Please try again.");
        return;
      }
      const r: any = await finalizeFn({ data: { setupIntentId: setupIntent.id } });
      toast.success(`Added ${r.brand ?? "card"} ****${r.last4 ?? ""}. It's now your default card`);
      onDone();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <PaymentElement />
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy || !stripe}>
          {busy ? "Saving…" : "Save card"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Platform -> tenant software add-ons (the upsell shelf): bolt-ons like the
// AI Receptionist that attach to the org's existing plan subscription as a
// Stripe subscription item and flip the matching feature on.
function PlatformAddonsSection({ planInterval }: { planInterval: BillingInterval | null }) {
  const copy = useLaunchCopy();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const listFn = useServerFn(listPlatformAddons);
  const subFn = useServerFn(subscribePlatformAddon);
  const cancelFn = useServerFn(cancelPlatformAddon);
  const { data, isLoading } = useQuery({
    queryKey: ["platform-addons"],
    queryFn: () => listFn(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["platform-addons"] });
    qc.invalidateQueries({ queryKey: ["billing-subscription-items"] });
  };
  const subscribe = useMutation({
    mutationFn: (addonId: string) => subFn({ data: { addonId } }),
    onSuccess: (r, addonId) => {
      const addon = (data?.addons ?? []).find((x) => x.id === addonId);
      toast.success(
        (r as { waived?: string } | undefined)?.waived
          ? "Added at no charge. Nothing is added to your invoice"
          : addon?.billing_interval === "one_time"
            ? "Purchase added. It will appear on your next invoice"
            : "Add-on added. The prorated amount for this period is charged today",
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: (addonId: string) => cancelFn({ data: { addonId } }),
    onSuccess: () => {
      toast.success("Add-on removed");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const addingId = subscribe.isPending ? (subscribe.variables as string) : null;
  const removingId = cancel.isPending ? (cancel.variables as string) : null;

  const addons = data?.addons ?? [];
  if (!isLoading && !addons.length) return null;
  // Done-for-you setup is free on Scale, for founding accounts and on yearly
  // billing (NP-4). The same rule the purchase runs on the server; the
  // interval comes from the subscription this page already reads.
  const setupFree = data?.setup ? setupIsFreeFor({ ...data.setup, planInterval }) : null;

  return (
    <section className="space-y-3">
      {dialog}
      <div>
        <h2 className="text-lg font-semibold">Add-ons</h2>
        <p className="text-sm text-muted-foreground">
          Optional extras that bolt onto your plan and show up on the same invoice.
        </p>
      </div>
      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {addons.map((a) => {
            // Availability belongs in the badge, not in stale catalog prose.
            const description = a.description?.replace(/^\s*Coming soon\.\s*/i, "");
            // Owned: only what the purchase recorded (a setup paid for before
            // the org qualified stays paid). Not owned: what it would cost now.
            const freeBecause = !isSetupAddon(a.slug)
              ? null
              : a.subscribed
                ? (a.waivedReason ?? null)
                : setupFree;
            const state = addonCardState(a);
            // Managed texting on the plan but not sending yet (site-r2-05).
            const texting = managedTextingCard(a);
            return (
            <div
              key={a.id}
              className={`flex flex-col rounded-xl border bg-card p-4 shadow-sm ${
                a.subscribed ? "border-primary/50 bg-primary/5" : ""
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">{a.name}</p>
                    {/* An add-on that has not launched reads Coming soon even
                      when it is on the plan (addonCardState, #428). */}
                    {state === "coming_soon" ? (
                      <Badge variant="outline">{copy("Coming soon")}</Badge>
                    ) : texting ? (
                      <ComingSoonBadge>{texting.label}</ComingSoonBadge>
                    ) : state === "for_sale" ? null : (
                    <StatusChip
                        status={state === "purchased" ? "paid" : "active"}
                      label={
                          state === "included"
                            ? "Included"
                            : state === "purchased"
                              ? "Purchased"
                              : "Active"
                      }
                    />
                    )}
                </div>
                {/* Annual orgs pay recurring add-ons yearly at 12x the monthly
                    amount (no discount), so show the amount they'll actually
                    be billed. One-time add-ons are unaffected by interval. */}
                {freeBecause ? (
                  <p className="whitespace-nowrap text-sm font-semibold">Included</p>
                ) : planInterval === "year" && a.billing_interval === "month" ? (
                  <p className="whitespace-nowrap text-right text-sm font-semibold">
                    {formatUsd(a.price_cents * 12)}
                    <span className="font-normal text-muted-foreground">/yr</span>
                    <span className="block text-xs font-normal text-muted-foreground">
                      billed with your annual plan
                    </span>
                  </p>
                ) : (
                  <p className="whitespace-nowrap text-sm font-semibold">
                    {formatUsd(a.price_cents)}
                    <span className="font-normal text-muted-foreground">
                      {a.billing_interval === "one_time" ? " one time" : `/${a.billing_interval}`}
                    </span>
                  </p>
                )}
              </div>
              {freeBecause && (
                <p className="mt-1 text-xs font-medium text-muted-foreground">
                  {a.subscribed
                    ? `${SETUP_FREE_BECAUSE[freeBecause]}. You were not charged.`
                    : `${SETUP_FREE_BECAUSE[freeBecause]}. ${formatUsd(a.price_cents)} one time otherwise.`}
                </p>
              )}
              {description && (
                <p className="mt-1 flex-1 text-sm text-muted-foreground">{description}</p>
              )}
                {texting && (
                  <p className="mt-1 text-xs font-medium text-muted-foreground" data-testid="managed-texting-state">
                    {texting.line}
                  </p>
                )}
                {state === "coming_soon" && a.subscribed && (
                  <p className="mt-1 text-xs font-medium text-muted-foreground">
                    {copy(HELD_ADDON_ON_PLAN)}
                  </p>
                )}
              <div className="mt-3">
                {a.subscribed && a.billing_interval === "one_time" ? null : a.subscribed ? (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={removingId === a.id}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: `Remove ${a.name} from your subscription?`,
                          destructive: true,
                          confirmLabel: "Remove add-on",
                        })
                      )
                        cancel.mutate(a.id);
                    }}
                  >
                    {removingId === a.id ? "Removing…" : "Remove from plan"}
                  </Button>
                  ) : state === "coming_soon" ? null : a.includedReason ? (
                  <Button size="sm" disabled title={a.includedReason}>
                    Included on your plan
                  </Button>
                ) : data?.canSubscribe ? (
                  <Button
                    size="sm"
                    disabled={addingId === a.id}
                    onClick={async () => {
                      // This condition used to read `billing_interval !==
                      // "one_time" || await confirm(...)`, which short-circuits
                      // — so the RECURRING purchase skipped the dialog and the
                      // one-time purchase got it. Exactly backwards: the
                      // one-time charge lands on the next invoice, while the
                      // recurring one invoices and charges the card on file
                      // today (`proration_behavior: "always_invoice"`). The
                      // app's own success toast has been saying so all along.
                      const oneTime = a.billing_interval === "one_time";
                      if (freeBecause) {
                        const ok = await confirm({
                          title: `Add ${a.name}?`,
                          description: `${SETUP_FREE_BECAUSE[freeBecause]}, so there is no charge and nothing is added to your invoice.`,
                          confirmLabel: "Add at no charge",
                        });
                        if (ok) subscribe.mutate(a.id);
                        return;
                      }
                      // Annual orgs pay a monthly-priced add-on at 12x, per
                      // the note on the price above. Confirm the number they
                      // will actually be billed, not the one on the label.
                      const billedYearly =
                        planInterval === "year" && a.billing_interval === "month";
                      const rate = billedYearly
                        ? `${formatUsd(a.price_cents * 12)} per year`
                        : `${formatUsd(a.price_cents)} per ${a.billing_interval}`;
                      const ok = await confirm({
                        title: oneTime ? `Purchase ${a.name}?` : `Add ${a.name} to your plan?`,
                        description: oneTime
                          ? `${a.name} is a one-time ${formatUsd(a.price_cents)} charge on your next invoice.`
                          : `${a.name} is ${rate}. The prorated amount for the rest of this billing period is charged to your card today, and it appears on every invoice after that until you remove it.`,
                        confirmLabel: oneTime ? "Purchase" : "Add to my plan",
                      });
                      if (ok) subscribe.mutate(a.id);
                    }}
                  >
                    {addingId === a.id
                      ? "Adding…"
                      : freeBecause
                        ? "Add at no charge"
                        : a.billing_interval === "one_time"
                        ? "Purchase"
                        : "Add to my plan"}
                  </Button>
                ) : (
                  <Button size="sm" disabled title="Add-ons attach to an active paid subscription">
                    Requires an active plan
                  </Button>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

// Upcoming-invoice style breakdown of the Stripe subscription: the plan line,
// seat overage as "Extra employees", and any bolt-on add-ons, with a monthly
// total. No portal trip needed to see the full bill.
function NextInvoice({
  subInfo,
  isLoading,
  isError,
  onRetry,
}: {
  subInfo:
    | {
        items: Array<{
          id: string;
          kind: "base" | "seat" | "addon";
          name: string;
          description: string | null;
          quantity: number;
          unitAmountCents: number | null;
          currency: string;
          interval: string | null;
          intervalCount: number;
        }>;
        currentPeriodEnd: string | null;
        subscriptionId: string | null;
        planInterval?: "month" | "year" | null;
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
}) {
  const items = subInfo?.items ?? [];
  const periodEnd = futureSubscriptionPeriodEnd(subInfo);
  const ordered = [
    ...items.filter((i) => i.kind === "base"),
    ...items.filter((i) => i.kind === "seat"),
    ...items.filter((i) => i.kind === "addon"),
  ];
  // Total in the subscription's own interval (all items share it; anything
  // odd an admin attached by hand is excluded and called out).
  const planInterval = subInfo?.planInterval ?? "month";
  // A line with no price is usage: the priced sum is shown with "+ usage",
  // never as if it were the whole bill.
  const total = nextInvoiceTotalCents(items, planInterval);
  const allSameInterval = items.every((i) => i.interval === planInterval && i.intervalCount === 1);
  const totalLabel = planInterval === "year" ? "Yearly total" : "Monthly total";
  const totalSuffix = planInterval === "year" ? "/yr" : "/mo";
  const totalText =
    total.hasUsage && !total.hasKnown
      ? "Usage only"
      : `${formatUsd(total.knownCents)}${totalSuffix}${total.hasUsage ? " + usage" : ""}`;

  const intervalSuffix = (i: (typeof items)[number]) =>
    i.interval
      ? `/${i.intervalCount > 1 ? `${i.intervalCount} ` : ""}${
          i.interval === "month" ? "mo" : i.interval === "year" ? "yr" : i.interval
        }`
      : "";
  const lineLabel = (i: (typeof items)[number]) => {
    if (i.kind === "seat") {
      return `Extra employees (${i.quantity} × ${formatUsd(i.unitAmountCents)}${intervalSuffix(i)})`;
    }
    return i.name;
  };
  const lineAmount = (i: (typeof items)[number]) => {
    if (i.unitAmountCents == null) return "Usage";
    const lineTotal = formatUsd(i.unitAmountCents * (i.quantity ?? 1));
    return `${lineTotal}${intervalSuffix(i)}`;
  };

  return (
    <section className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
      <h2 className="text-lg font-semibold">Your next invoice</h2>
      {periodEnd && (
        <p className="text-sm text-muted-foreground">Bills {formatDay(periodEnd)}</p>
      )}
      {isLoading ? (
        <div className="mt-3">
          <LineBones rows={2} />
        </div>
      ) : isError && !subInfo ? (
        // Not "No subscription line items": a failed read is not an empty plan.
        <LoadError className="mt-3" what="your next invoice" onRetry={onRetry} />
      ) : ordered.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">No subscription line items to show.</p>
      ) : (
        <>
          <ul className="mt-3 divide-y">
            {ordered.map((i) => (
              <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-2.5">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="font-medium">{lineLabel(i)}</p>
                    {i.kind === "base" && <MetaChip>Plan</MetaChip>}
                    {i.kind === "addon" && <MetaChip>Add-on</MetaChip>}
                  </div>
                  {i.kind !== "seat" && i.description && (
                    <p className="text-xs text-muted-foreground">{i.description}</p>
                  )}
                </div>
                <p className="whitespace-nowrap text-right text-sm">{lineAmount(i)}</p>
              </li>
            ))}
          </ul>
          <div className="mt-1 flex items-center justify-between border-t pt-3">
            <p className="text-sm font-semibold">
              {allSameInterval ? totalLabel : `${totalLabel} (excludes other billing periods)`}
            </p>
            <p className="text-sm font-semibold">
              {totalText}
            </p>
          </div>
        </>
      )}
    </section>
  );
}

// In-app billing history (punch list #10) - no portal round-trip needed just
// to see or download an invoice.
function InvoiceHistory() {
  const listFn = useServerFn(listPlatformInvoices);
  const { data, isLoading } = useQuery({
    queryKey: ["platform-invoices"],
    queryFn: () => listFn(),
  });
  const invoices: any[] = (data as any)?.invoices ?? [];

  return (
    // Five columns of invoice history, with no scroll container of their own —
    // so the table set the width of the settings page instead of its own.
    <section className="overflow-x-auto rounded-xl border bg-card p-(--card-pad) shadow-sm">
      <h2 className="text-lg font-semibold">Billing history</h2>
      {isLoading ? (
        <p className="mt-2 text-sm text-muted-foreground">Loading…</p>
      ) : invoices.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">
          No invoices yet. Your subscription invoices will appear here once you're billed.
        </p>
      ) : (
        <table className="mt-3 w-full text-sm min-w-[480px]">
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
                <td className="py-2 font-medium">
                  {inv.number ?? inv.stripe_invoice_id.slice(0, 12)}
                </td>
                <td className="py-2 text-muted-foreground">
                  {formatBillingPeriod(inv.period_start, inv.period_end)}
                </td>
                <td className="py-2">
                  {formatUsd(inv.amount_due_cents)}
                  {/* A refund is stated on its own line rather than folded into
                      the amount. Netting it silently would show a smaller
                      number than the invoice the client can open from the
                      link two columns across, which reads as a mistake in the
                      invoice rather than as money returned. */}
                  {(inv.refunded_cents ?? 0) > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      −{formatUsd(inv.refunded_cents)} refunded
                    </span>
                  )}
                </td>
                <td className="py-2">
                  <StatusChip status={inv.status === "open" ? "open" : inv.status} />
                </td>
                <td className="py-2 text-right">
                  {inv.hosted_invoice_url && (
                    <a
                      href={inv.hosted_invoice_url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline"
                    >
                      View
                    </a>
                  )}
                  {inv.invoice_pdf && (
                    <a
                      href={inv.invoice_pdf}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-3 text-primary underline"
                    >
                      PDF
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
