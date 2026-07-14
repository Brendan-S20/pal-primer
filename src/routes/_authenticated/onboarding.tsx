import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getBillingStatus } from "@/lib/billing.functions";
import { PlanPicker, EmbeddedPlanCheckout } from "@/components/billing/PlanPicker";
import { APP_NAME } from "@/lib/scoop";

// Post-signup onboarding path (Brendan's re-review): "Create account" lands
// here instead of dropping new owners straight onto an empty dashboard —
// welcome them, pitch the plans, and take payment in-app (embedded checkout).
// Everything chosen here stays manageable later in Settings → Plan & billing.
export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({ meta: [{ title: `Welcome - ${APP_NAME}` }] }),
  component: OnboardingPage,
});

type Step = "welcome" | "plan" | "checkout" | "done";

function OnboardingPage() {
  const navigate = useNavigate();
  const statusFn = useServerFn(getBillingStatus);
  const { data: billing } = useQuery({ queryKey: ["billing-status"], queryFn: () => statusFn() });
  // Returning from the embedded checkout lands back here with ?paid=1.
  const [step, setStep] = useState<Step>(() =>
    typeof window !== "undefined" && new URL(window.location.href).searchParams.get("paid") === "1"
      ? "done"
      : "welcome",
  );
  const [planId, setPlanId] = useState<string | null>(null);

  const steps: Array<{ key: Step; label: string }> = [
    { key: "welcome", label: "Welcome" },
    { key: "plan", label: "Pick a plan" },
    { key: "checkout", label: "Payment" },
  ];
  const stepIndex = steps.findIndex((s) => s.key === (step === "done" ? "checkout" : step));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s.key} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                i <= stepIndex ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              }`}
            >
              {i < stepIndex || step === "done" ? "✓" : i + 1}
            </div>
            <span className={`text-sm ${i === stepIndex ? "font-medium" : "text-muted-foreground"}`}>{s.label}</span>
            {i < steps.length - 1 && <div className="h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>

      {step === "welcome" && (
        <div className="rounded-xl border bg-card p-8">
          <h1 className="text-2xl font-semibold">
            Welcome to {APP_NAME}{billing?.orgName ? `, ${billing.orgName}` : ""} 🎉
          </h1>
          <p className="mt-2 max-w-xl text-sm text-muted-foreground">
            Your workspace is ready. Two minutes of setup gets you running: pick the plan that fits
            your crew (every tier has unlimited customers, jobs, routes, and zones; you're billed
            per employee), then explore your dashboard. You can change or cancel the plan anytime in
            Settings → Plan &amp; billing.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            <Button onClick={() => setStep("plan")}>Pick a plan</Button>
            <Button variant="ghost" onClick={() => navigate({ to: "/dashboard" })}>
              Skip for now, start on the free trial
            </Button>
          </div>
        </div>
      )}

      {step === "plan" && (
        <div className="space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Pick the plan that fits your crew</h1>
            <p className="text-sm text-muted-foreground">
              Payment happens right here. You won't leave the app. Change or cancel anytime.
            </p>
          </div>
          <PlanPicker
            currentSlug={billing?.planSlug}
            onSelect={(id) => { setPlanId(id); setStep("checkout"); }}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setStep("welcome")}>Back</Button>
            <Button variant="ghost" onClick={() => navigate({ to: "/dashboard" })}>
              Skip for now
            </Button>
          </div>
        </div>
      )}

      {step === "checkout" && planId && (
        <EmbeddedPlanCheckout
          planId={planId}
          returnUrl={typeof window !== "undefined" ? `${window.location.origin}/onboarding?paid=1` : "https://app.houndstack.com/onboarding?paid=1"}
          onCancel={() => setStep("plan")}
        />
      )}

      {step === "done" && (
        <div className="rounded-xl border bg-card p-8 text-center">
          <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
          <h1 className="mt-3 text-xl font-semibold">You're all set</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your plan is active. Manage it anytime in Settings → Plan &amp; billing.
          </p>
          <Link to="/dashboard" className="mt-5 inline-block">
            <Button>Go to your dashboard</Button>
          </Link>
        </div>
      )}
    </div>
  );
}
