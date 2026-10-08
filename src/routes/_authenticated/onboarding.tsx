import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2 } from "lucide-react";
import { saasPurchaseAllowed } from "@/lib/app-store-billing";
import { platform } from "@/lib/native";
import { Button } from "@/components/ui/button";
import { getBillingStatus, listSubscriptionItems } from "@/lib/billing.functions";
import {
  PlanPicker,
  EmbeddedPlanCheckout,
  type BillingInterval,
} from "@/components/billing/PlanPicker";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { APP_NAME } from "@/lib/scoop";
import { appUrl } from "@/lib/app-origin";
import { pageTitle } from "@/lib/page-title";

// Post-signup onboarding path (Brendan's re-review): "Create account" lands
// here instead of dropping new owners straight onto an empty dashboard —
// welcome them, pitch the plans, and take payment in-app (embedded checkout).
// Everything chosen here stays manageable later in Settings → Plan & billing.
export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({ meta: [{ title: pageTitle("Welcome") }] }),
  component: OnboardingPage,
});

type Step = "welcome" | "plan" | "checkout" | "done";

function OnboardingPage() {
  // A store build may not steer toward a purchase, in copy or in controls.
  const canBuySaas = saasPurchaseAllowed(platform());
  const navigate = useNavigate();
  const statusFn = useServerFn(getBillingStatus);
  const { data: billing } = useQuery({ queryKey: ["billing-status"], queryFn: () => statusFn() });
  // A paid org revisiting onboarding keeps its live billing interval: without
  // this the toggle defaults to monthly and picking any plan would silently
  // rewrite an annual subscription to monthly billing.
  const itemsFn = useServerFn(listSubscriptionItems);
  const { data: subInfo } = useQuery({
    queryKey: ["billing-subscription-items"],
    queryFn: () => itemsFn(),
    enabled: !!billing?.isPaidTier,
  });
  const currentInterval = ((subInfo as any)?.planInterval ?? null) as "month" | "year" | null;
  // Returning from the embedded checkout lands back here with ?paid=1.
  const [step, setStep] = useState<Step>(() =>
    typeof window !== "undefined" && new URL(window.location.href).searchParams.get("paid") === "1"
      ? "done"
      : "welcome",
  );
  const [plan, setPlan] = useState<{ planId: string; interval: BillingInterval } | null>(null);
  const { confirm, dialog } = useConfirmDialog();

  // Already-subscribed orgs revisiting onboarding: the checkout step
  // switches the LIVE subscription in place (prorated, no payment form),
  // so picking a plan must be confirmed like it is in Settings > Billing.
  async function pickPlan(id: string, _name: string, interval: BillingInterval) {
    if (billing?.isPaidTier) {
      const ok = await confirm({
        title: "Switch your plan?",
        description:
          "You already have an active subscription. Switching changes it right away. If the new plan costs more, the prorated difference is charged today; if it costs less, the difference is credited to your next invoice.",
        confirmLabel: "Switch plan",
      });
      if (!ok) return;
    }
    setPlan({ planId: id, interval });
    setStep("checkout");
  }

  const steps: Array<{ key: Step; label: string }> = [
    { key: "welcome", label: "Welcome" },
    { key: "plan", label: "Pick a plan" },
    { key: "checkout", label: "Payment" },
  ];
  const stepIndex = steps.findIndex((s) => s.key === (step === "done" ? "checkout" : step));

  return (
    <>
      {dialog}
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.key} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                i <= stepIndex
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground"
              }`}
            >
              {i < stepIndex || step === "done" ? "✓" : i + 1}
            </div>
            <span
              className={`text-sm ${i === stepIndex ? "font-medium" : "text-muted-foreground"}`}
            >
              {s.label}
            </span>
            {i < steps.length - 1 && <div className="h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>

      {step === "welcome" && (
        <div className="rounded-xl border bg-card p-8">
          <h1 className="text-2xl font-semibold">
            Welcome to {APP_NAME}
            {billing?.orgName ? `, ${billing.orgName}` : ""} 🎉
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Your workspace is ready. Two minutes of setup gets you running: pick the plan that fits
            your crew (every tier has unlimited clients, jobs, routes and zones; you're billed per
            employee), then set the business up: an address, a price, a first client. You can
            change or cancel the plan anytime in Settings → Plan &amp; billing.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={() => setStep("plan")}>Pick a plan</Button>
            <Button variant="ghost" onClick={() => navigate({ to: "/setup" })}>
              Skip for now, start on the free trial
            </Button>
          </div>
        </div>
      )}

      {step === "plan" && (
        <div className="space-y-4">
          {/* The HEADINGS need the gate as much as the picker does. PlanPicker
              refuses to render a purchase inside a store build, but it cannot
              see the copy wrapped around it — and "Payment happens right here.
              You won't leave the app." is a purchase instruction whether or
              not anything below it is buyable. Caught by a rendered test after
              the component gate was already in place. */}
          <div>
            <h1 className="text-xl font-semibold">
              {canBuySaas ? "Pick the plan that fits your crew" : "Your plan"}
            </h1>
            <p className="text-sm text-muted-foreground">
              {canBuySaas
                ? "Payment happens right here. You won't leave the app. Change or cancel anytime."
                : "Plan changes are handled outside the mobile app. Everything else here works as normal."}
            </p>
          </div>
          <PlanPicker
            currentSlug={billing?.planSlug}
            currentInterval={currentInterval}
            onSelect={pickPlan}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep("welcome")}>
              Back
            </Button>
            <Button variant="ghost" onClick={() => navigate({ to: "/setup" })}>
              Skip for now
            </Button>
          </div>
        </div>
      )}

      {step === "checkout" && plan && (
        <EmbeddedPlanCheckout
          planId={plan.planId}
          interval={plan.interval}
          // Was: page origin in the browser, appUrl() only on the server. That
          // branch is exactly backwards for the native build, where a browser
          // IS present and its origin is capacitor://localhost — so the one
          // path that could not work was the one it preferred.
          returnUrl={appUrl("/onboarding?paid=1")}
          onCancel={() => setStep("plan")}
          // Already subscribed (e.g. revisiting onboarding): the plan was
          // switched in place, no payment form needed.
          onSwitched={() => setStep("done")}
        />
      )}

      {step === "done" && (
        <div className="rounded-xl border bg-card p-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-primary shrink-0" />
          <h1 className="mt-3 text-xl font-semibold">You're all set</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your plan is active. Manage it anytime in Settings → Plan &amp; billing.
          </p>
          {/* Onward to the guided setup, not an empty dashboard: a plan is
              not a business until it has a price and a client. */}
          <Link to="/setup" className="mt-5 inline-block">
            <Button>Set up your business</Button>
          </Link>
        </div>
      )}
    </>
  );
}
