import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, ChevronDown, ChevronUp, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { canAccess, useMyRole } from "@/hooks/useMyRole";
import { getOnboardingStatus, dismissOnboarding } from "@/lib/onboarding.functions";
import {
  SETUP_PATH,
  canRunSetup,
  openSetupGuide,
  readRememberedStep,
  startingStep,
  stepsFor,
  useSetupGuide,
} from "@/lib/setup-guide";
import { setupProgressPct } from "@/lib/setup-progress";

type Step = {
  id: string;
  done: boolean;
};

/**
 * Which steps the card draws before anybody asks for more.
 *
 * ── WHY IT FOLDS ──────────────────────────────────────────────────────────
 *
 * The card listed all seven steps at full height, finished ones included, at
 * the top of the dashboard. On a phone that was two screens of "Get started"
 * before the day's alerts, the techs out today and the overdue invoices (launch
 * pass, 2026-10, recommendation 8). A finished step is something you have
 * already done; it does not need a row.
 *
 * So, folded: finished steps are hidden at every width (the count and the bar
 * still say how far along you are), and on a phone only the NEXT step is
 * drawn, because one thing to do is what fits above the day. "Show all steps"
 * opens the whole list, finished ones included, at any width.
 *
 * Returned as a reason per step rather than a filtered list, so the phone and
 * desktop cases are one render with a breakpoint class, not two lists that
 * can drift apart.
 */
export function stepVisibility(
  steps: Step[],
  expanded: boolean,
): Record<string, "shown" | "desktop-only" | "hidden"> {
  const next = steps.find((s) => !s.done)?.id;
  const out: Record<string, "shown" | "desktop-only" | "hidden"> = {};
  for (const s of steps) {
    if (expanded) out[s.id] = "shown";
    else if (s.done) out[s.id] = "hidden";
    else if (s.id === next) out[s.id] = "shown";
    else out[s.id] = "desktop-only";
  }
  return out;
}

/**
 * Where the checklist sits on the dashboard.
 *
 * Until the business has a client it is the main thing to do, so it is the
 * full card at the top. Once a client exists the business is running, and the
 * full card pushed the day's numbers below the fold (QA row 44). From then on
 * it is one line under the KPIs with a "Finish setup" button. The clients
 * step's `done` is the server's `clients.count > 0`.
 */
export function checklistPlacement(steps: Step[]): "top" | "below-kpis" {
  return steps.some((s) => s.id === "clients" && s.done) ? "below-kpis" : "top";
}

export function OnboardingChecklist({
  placement = "top",
}: {
  /** Which of the two dashboard slots this instance fills. Each renders only
   *  when `checklistPlacement` picks it, so the page can hold both. */
  placement?: "top" | "below-kpis";
} = {}) {
  const qc = useQueryClient();
  const { role } = useMyRole();
  const statusFn = useServerFn(getOnboardingStatus);
  const dismissFn = useServerFn(dismissOnboarding);
  const [expanded, setExpanded] = useState(false);
  const navigate = useNavigate();
  const guide = useSetupGuide();

  const { data } = useQuery({
    queryKey: ["onboarding-status"],
    queryFn: () => statusFn(),
    staleTime: 30_000,
  });

  if (!data) return null;
  if (data.dismissed) return null;
  // The same six steps the guided setup walks, and only the ones this role
  // can do: a dispatcher was shown "Connect Stripe" and "Invite tech" with
  // buttons into pages that turned them away. Nobody who cannot run setup
  // gets the card at all.
  if (!canRunSetup(role)) return null;
  const steps = stepsFor(data.steps, role);
  if (steps.length === 0) return null;
  const completed = steps.filter((s) => s.done).length;
  const total = steps.length;

  const pct = setupProgressPct(steps);
  const allDone = completed === total;
  const visibility = stepVisibility(steps, expanded);
  const foldedAway = steps.filter((s) => visibility[s.id] !== "shown").length;

  /** The checklist is the guide's front door: "Guide me" opens it at the
   *  step they were on, or the first one still open. */
  const guideMe = () => {
    openSetupGuide();
    void navigate({
      to: SETUP_PATH,
      search: { step: startingStep(steps, readRememberedStep(guide.userId)) ?? undefined },
    });
  };

  const handleDismiss = async () => {
    await dismissFn();
    qc.invalidateQueries({ queryKey: ["onboarding-status"] });
  };

  if (checklistPlacement(steps) !== placement) return null;

  if (placement === "below-kpis") {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card px-4 py-2 text-sm max-md:order-2"
        data-testid="onboarding-checklist"
        data-compact=""
      >
        <p className="min-w-0 text-muted-foreground">
          {allDone ? "Setup is complete." : `Setup: ${completed} of ${total} steps done.`}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          {!allDone && (
            <Button
              size="sm"
              variant="outline"
              onClick={guideMe}
              className="touch:min-h-11"
              data-testid="setup-guide-me"
            >
              Finish setup
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={handleDismiss}
            aria-label="Dismiss the setup checklist"
            title="Dismiss the setup checklist"
            className="shrink-0 touch:h-11 touch:w-11"
          >
            <X className="h-4 w-4 shrink-0" />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4 md:p-5" data-testid="onboarding-checklist">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{allDone ? "You're all set" : "Get started"}</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {allDone
              ? "Every setup step is complete. Dismiss this card to hide it."
              : `${completed} of ${total} steps complete`}
          </p>
        </div>
        {/* Dismissing is for good (the server records it), so it says so in
            its name rather than being an anonymous ×. 44px on touch: the glyph
            stays 16px, the box around it is what a thumb hits. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={handleDismiss}
          aria-label="Dismiss the setup checklist"
          title="Dismiss the setup checklist"
          className="shrink-0 touch:h-11 touch:w-11"
        >
          <X className="h-4 w-4 shrink-0" />
        </Button>
      </div>

      <div className="mt-3">
        <Progress value={pct} />
      </div>

      {!allDone && (
        <Button className="mt-3" onClick={guideMe} data-testid="setup-guide-me">
          {completed > 0 ? "Continue guided setup" : "Guide me through it"}
        </Button>
      )}

      <ul className="mt-4 space-y-3">
        {steps.map((step) => (
          <li
            key={step.id}
            data-step={step.id}
            // flex-wrap so the controls drop to their own line when the row
            // cannot hold both columns. Without it the row never wraps at all:
            // the controls block below is shrink-0, so it always claims its
            // max-content width and the INNER flex-wrap can never engage --
            // the two are in tension, and shrink-0 wins. Found at 320px, where
            // "Import CSV" ran to x=326 in a 320px viewport.
            //
            // `max-md:hidden` is show-or-hide keyed on width, which is what
            // width is for (CLAUDE.md: "show-or-hide may key on width").
            className={`flex flex-wrap items-start justify-between gap-4 rounded-md border p-3 ${
              visibility[step.id] === "hidden"
                ? "hidden"
                : visibility[step.id] === "desktop-only"
                  ? "max-md:hidden"
                  : ""
            }`}
          >
            <div className="flex items-start gap-3">
              {/* shrink-0: a flex item without it gives up width to long text,
                  and each row's description is a different length, so each
                  icon was squeezed by a different amount and the titles began
                  anywhere from x=165 to x=177 (iPhone 17 Pro, 1x). */}
              {step.done ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
              )}
              <div>
                <div
                  className={
                    "text-sm font-medium " + (step.done ? "text-muted-foreground line-through" : "")
                  }
                >
                  {step.label}
                </div>
                <div className="text-xs text-muted-foreground">{step.description}</div>
              </div>
            </div>
            {!step.done && (
              // shrink-0 so the label column cannot squeeze the controls off
              // the card, and flex-wrap so two buttons stack rather than
              // overflow. This pair only works because the row above wraps:
              // 360px fits and 320px did not, which is why the original note
              // here named 360 and passed. The label column carries no min-w-0 and
              // does not need one: it is wrapping prose, so its min-content
              // width is its longest WORD. The rule in CLAUDE.md bites when a
              // value has no space in it to break on, which no copy here does.
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                {/* A step done on /setup opens the guide AT that step; the
                    rest go to the page where they are done. */}
                <Link
                  to={step.to}
                  search={step.to === SETUP_PATH ? { step: step.id } : undefined}
                  onClick={step.to === SETUP_PATH ? openSetupGuide : undefined}
                >
                  <Button size="sm" variant="outline">
                    {step.cta}
                  </Button>
                </Link>
                {step.alt && canAccess(role, step.alt.gate) && (
                  <Link to={step.alt.to}>
                    <Button size="sm" variant="outline">
                      {step.alt.cta}
                    </Button>
                  </Link>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {(foldedAway > 0 || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="mt-2 inline-flex min-h-9 items-center gap-1 text-sm font-medium text-primary hover:underline touch:min-h-11"
        >
          {expanded ? (
            <>
              Show less <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
            </>
          ) : (
            <>
              Show all {total} steps{" "}
              <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
            </>
          )}
        </button>
      )}
    </div>
  );
}
