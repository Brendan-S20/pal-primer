import { Link, useRouterState } from "@tanstack/react-router";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useMyRole } from "@/hooks/useMyRole";
import { useOnboardingStatus } from "@/hooks/useOnboardingStatus";
import {
  SETUP_PATH,
  closeSetupGuide,
  promptsSetup,
  readRememberedStep,
  setupBanner,
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
  const allowed = promptsSetup(role);
  // The same query as the dashboard checklist and /setup (D5, D9): one
  // answer, refreshed by every mutation that can finish a step.
  const { data } = useOnboardingStatus({ enabled: allowed && guide.phase === "open" });

  if (!allowed || guide.phase !== "open" || !data) return null;
  // On /setup the page is the guide. On /onboarding the owner is choosing a
  // plan, and the next thing that page offers IS the setup.
  if (pathname === SETUP_PATH || pathname.startsWith("/onboarding")) return null;
  if (data.dismissed) return null;

  const steps = stepsFor(data.steps, role);
  // Progress is the server's; the device only says where to resume.
  const { done, total, started, step, nextLabel, cta } = setupBanner(
    steps,
    readRememberedStep(guide.userId),
  );
  if (!total || done === total) return null;

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
              Setup: {done} of {total} done.
            </span>{" "}
            {nextLabel && <span className="text-muted-foreground">Next: {nextLabel}</span>}
          </>
        ) : (
          <>
            <span className="font-medium">Set up your business in {total} short steps.</span>{" "}
            <span className="text-muted-foreground">About five minutes, all of it skippable.</span>
          </>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1">
        <Button asChild size="sm">
          <Link to={SETUP_PATH} search={{ step: step ?? undefined }}>
            {cta}
          </Link>
        </Button>
        <Button size="sm" variant="ghost" onClick={closeSetupGuide}>
          Not now
        </Button>
      </span>
    </div>
  );
}
