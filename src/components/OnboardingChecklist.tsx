import { Link } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Circle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { canAccess, useMyRole } from "@/hooks/useMyRole";
import { getOnboardingStatus, dismissOnboarding } from "@/lib/onboarding.functions";

export function OnboardingChecklist() {
  const qc = useQueryClient();
  const { role } = useMyRole();
  const statusFn = useServerFn(getOnboardingStatus);
  const dismissFn = useServerFn(dismissOnboarding);

  const { data } = useQuery({
    queryKey: ["onboarding-status"],
    queryFn: () => statusFn(),
  });

  if (!data) return null;
  if (data.dismissed) return null;
  if (data.total === 0) return null;

  const pct = Math.round((data.completed / data.total) * 100);
  const allDone = data.completed === data.total;

  const handleDismiss = async () => {
    await dismissFn();
    qc.invalidateQueries({ queryKey: ["onboarding-status"] });
  };

  return (
    <div className="rounded-lg border bg-card p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">
            {allDone ? "You're all set" : "Get started"}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {allDone
              ? "Every setup step is complete. Dismiss this card to hide it."
              : `${data.completed} of ${data.total} steps complete`}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={handleDismiss} aria-label="Dismiss">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-4">
        <Progress value={pct} />
      </div>

      <ul className="mt-5 space-y-3">
        {data.steps.map((step) => (
          <li
            key={step.id}
            // flex-wrap so the controls drop to their own line when the row
            // cannot hold both columns. Without it the row never wraps at all:
            // the controls block below is shrink-0, so it always claims its
            // max-content width and the INNER flex-wrap can never engage --
            // the two are in tension, and shrink-0 wins. Found at 320px, where
            // "Import CSV" ran to x=326 in a 320px viewport.
            className="flex flex-wrap items-start justify-between gap-4 rounded-md border p-3"
          >
            <div className="flex items-start gap-3">
              {step.done ? (
                <CheckCircle2 className="mt-0.5 h-5 w-5 text-primary" />
              ) : (
                <Circle className="mt-0.5 h-5 w-5 text-muted-foreground" />
              )}
              <div>
                <div
                  className={
                    "text-sm font-medium " +
                    (step.done ? "text-muted-foreground line-through" : "")
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
                <Link to={step.to}>
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
    </div>
  );
}
