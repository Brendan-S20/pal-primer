import { Link, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMyRole } from "@/hooks/useMyRole";
import { getOnboardingStatus } from "@/lib/onboarding.functions";
import {
  SETUP_PATH,
  canRunSetup,
  closeSetupGuide,
  readRememberedStep,
  startingStep,
  stepsFor,
  useSetupGuide,
} from "@/lib/setup-guide";

/**
 * The guided setup's presence everywhere except /setup itself.
 *
 * One line in the page flow, under the header, where the trial notice sits:
 * never an overlay. The spotlight tour this replaces was a `fixed inset-0`
 * layer over the live app with a card positioned by measuring other chrome,
 * and from `md` up it measured a hidden tab bar and put its own Next button
 * above the screen. A banner in the flow has no position to get wrong: it
 * cannot cover anything and cannot be covered.
 *
 * It is what makes the guide survive leaving it. The clients step sends the
 * owner to /clients/new on purpose, because that form is the right tool; when
 * they save, this is on the client's page saying "Continue setup", and it goes
 * back to the step they were on.
 *
 * "Not now" closes the guide for this person, on this device and on their
 * account, exactly as skipping the tour did. The dashboard checklist and the
 * Knowledge Center both open it again.
 */
export function SetupGuideBanner() {
  const { role } = useMyRole();
  const guide = useSetupGuide();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const allowed = canRunSetup(role);
  const statusFn = useServerFn(getOnboardingStatus);
  const { data } = useQuery({
    queryKey: ["onboarding-status"],
    queryFn: () => statusFn(),
    enabled: allowed && guide.phase === "open",
    staleTime: 30_000,
  });

  if (!allowed || guide.phase !== "open" || !data) return null;
  // On /setup the page is the guide. On /onboarding the owner is choosing a
  // plan, and the next thing that page offers IS the setup.
  if (pathname === SETUP_PATH || pathname.startsWith("/onboarding")) return null;
  if (data.dismissed) return null;

  const steps = stepsFor(data.steps, role);
  const done = steps.filter((s) => s.done).length;
  if (!steps.length || done === steps.length) return null;

  const remembered = readRememberedStep(guide.userId);
  const step = startingStep(steps, remembered);
  const current = steps.find((s) => s.id === step);
  const started = !!remembered;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-primary/5 py-1.5 pe-2 ps-4 text-sm"
      data-testid="setup-guide-banner"
      role="region"
      aria-label="Business setup"
    >
      <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden />
      <span className="min-w-0 flex-1 basis-48">
        {started ? (
          <>
            <span className="font-medium">
              Setup: {done} of {steps.length} done.
            </span>{" "}
            <span className="text-muted-foreground-strong">Next: {current?.label}</span>
          </>
        ) : (
          <>
            <span className="font-medium">Set up your business in {steps.length} short steps.</span>{" "}
            <span className="text-muted-foreground-strong">
              About five minutes, all of it skippable.
            </span>
          </>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Button asChild size="sm">
          <Link to={SETUP_PATH} search={{ step: step ?? undefined }}>
            {started ? "Continue setup" : "Start setup"}
          </Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={closeSetupGuide}>
          Not now
        </Button>
      </span>
    </div>
  );
}
