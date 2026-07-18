import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { supabase, isImpersonationTab } from "@/integrations/supabase/client";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { APP_NAME } from "@/lib/scoop";

// Feature 4: one-time first-sign-in guided tour. Deliberately dependency-free
// (a spotlight overlay + positioned card) — tour libraries lag React majors
// and this needs ~6 steps, not a framework. Coexists with the "Get started"
// checklist: the tour explains what things ARE, the checklist tracks what's
// left to CONFIGURE.
//
// Persistence is per-user (auth user_metadata.tour_seen_at), not per-org, so a
// teammate added later still gets their own first-login tour, on any device.

const RESTART_EVENT = "hs:restart-tour";

/** Re-launch the tour (e.g. from the Knowledge Center). */
export function restartTour() {
  window.dispatchEvent(new CustomEvent(RESTART_EVENT));
}

type Step = {
  /** data-tour anchor (sidebar item url). Empty = centered welcome card. */
  anchor?: string;
  title: string;
  body: string;
};

const ALL_STEPS: Array<Step & { requiresAccess?: string }> = [
  {
    title: `Welcome to ${APP_NAME}!`,
    body: "A quick 60-second orientation of the main areas. You can skip at any point, and re-run it later from the Knowledge Center.",
  },
  {
    anchor: "/dashboard",
    requiresAccess: "/dashboard",
    title: "Dashboard",
    body: "Your morning glance: today's visits, revenue, alerts, and the Get-started checklist that tracks what's left to set up.",
  },
  {
    anchor: "/clients",
    requiresAccess: "/clients",
    title: "Clients",
    body: "Every customer lives here: their properties, dogs, subscriptions, invoices, and portal link.",
  },
  {
    anchor: "/zones",
    requiresAccess: "/zones",
    title: "Zones",
    body: "A zone is a service area (a neighborhood or ZIP prefix). Routes, weather, and reports are all organized around zones, so set these up early.",
  },
  {
    anchor: "/routes",
    requiresAccess: "/routes",
    title: "Routes",
    body: "Plan who goes where: assign visits to techs by zone, drag to reorder, and view the day on a map or board.",
  },
  {
    anchor: "/my-day",
    requiresAccess: "/my-day",
    title: "My Day",
    body: "The field view: techs see their route in order, start and complete visits, snap photos, log skips, and bill add-ons.",
  },
  {
    anchor: "/invoices",
    requiresAccess: "/invoices",
    title: "Invoices",
    body: 'Billing runs on completed visits. Generate them in a batch, or use "New invoice" to bill a client directly for one-off work.',
  },
  {
    anchor: "/settings",
    requiresAccess: "/settings",
    title: "Settings",
    body: "Skip rules, blackout dates, add-on services, texting, payments. When something needs configuring, it's in here. That's the tour!",
  },
];

function getAnchorRect(anchor?: string): DOMRect | null {
  if (!anchor) return null;
  const el = document.querySelector(`[data-tour="${anchor}"]`);
  if (!el) return null;
  const r = (el as HTMLElement).getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? r : null;
}

export function OnboardingTour() {
  const { role, loading } = useMyRole();
  const [phase, setPhase] = useState<"unknown" | "hidden" | "active">("unknown");
  const [stepIdx, setStepIdx] = useState(0);
  const [, forceTick] = useState(0);

  const steps = useMemo(
    () => ALL_STEPS.filter((s) => !s.requiresAccess || canAccess(role, s.requiresAccess)),
    [role],
  );

  // Decide once per session whether this user has seen the tour. Never
  // auto-fire in an impersonation tab (H3): the admin doesn't need the tour,
  // and dismissing it would consume the impersonated user's tour state.
  useEffect(() => {
    if (loading || phase !== "unknown") return;
    if (isImpersonationTab()) {
      setPhase("hidden");
      return;
    }
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (cancelled) return;
      const seen = data.user?.user_metadata?.tour_seen_at;
      setPhase(seen ? "hidden" : "active");
    });
    return () => {
      cancelled = true;
    };
  }, [loading, phase]);

  useEffect(() => {
    const onRestart = () => {
      setStepIdx(0);
      setPhase("active");
    };
    window.addEventListener(RESTART_EVENT, onRestart);
    return () => window.removeEventListener(RESTART_EVENT, onRestart);
  }, []);

  // Keep the spotlight glued to its anchor on resize/scroll.
  useEffect(() => {
    if (phase !== "active") return;
    const bump = () => forceTick((n) => n + 1);
    window.addEventListener("resize", bump);
    window.addEventListener("scroll", bump, true);
    return () => {
      window.removeEventListener("resize", bump);
      window.removeEventListener("scroll", bump, true);
    };
  }, [phase]);

  const finish = useCallback(async () => {
    setPhase("hidden");
    // An impersonating admin restarting the tour manually must not stamp the
    // impersonated user's tour_seen_at.
    if (isImpersonationTab()) return;
    try {
      await supabase.auth.updateUser({
        data: { tour_seen_at: new Date().toISOString() },
      });
    } catch {
      // Metadata write failing just means they may see the tour again.
    }
  }, []);

  if (phase !== "active" || !steps.length) return null;
  const step = steps[Math.min(stepIdx, steps.length - 1)];
  const rect = getAnchorRect(step.anchor);
  const isLast = stepIdx >= steps.length - 1;

  return (
    <div className="fixed inset-0 z-[100]" role="dialog" aria-label="Guided tour">
      {/* Spotlight: the highlighted element stays visible through a cutout. */}
      {rect ? (
        <div
          className="absolute rounded-md transition-all duration-200"
          style={{
            top: rect.top - 6,
            left: rect.left - 6,
            width: rect.width + 12,
            height: rect.height + 12,
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.55)",
            pointerEvents: "none",
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-black/55" />
      )}

      <div
        className="absolute w-80 max-w-[calc(100vw-2rem)] rounded-lg border bg-card p-4 shadow-xl"
        style={
          rect
            ? {
                top: Math.min(rect.top, window.innerHeight - 220),
                left: Math.min(rect.right + 16, window.innerWidth - 340),
              }
            : { top: "50%", left: "50%", transform: "translate(-50%, -50%)" }
        }
      >
        <div className="text-xs text-muted-foreground">
          {stepIdx + 1} of {steps.length}
        </div>
        <h3 className="mt-1 text-base font-semibold">{step.title}</h3>
        <p className="mt-1 text-sm text-muted-foreground">{step.body}</p>
        <div className="mt-4 flex items-center justify-between gap-2">
          {/* Skip is present on every step, per spec. */}
          <Button variant="ghost" size="sm" onClick={finish}>
            Skip tour
          </Button>
          <div className="flex gap-2">
            {stepIdx > 0 && (
              <Button variant="outline" size="sm" onClick={() => setStepIdx((i) => i - 1)}>
                Back
              </Button>
            )}
            <Button size="sm" onClick={() => (isLast ? finish() : setStepIdx((i) => i + 1))}>
              {stepIdx === 0 ? "Start the tour" : isLast ? "Done" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
