import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { getTrialState } from "@/lib/trial.functions";
import { TRIAL_COPY } from "@/lib/trial";
import type { TrialState } from "@/lib/trial";
import { useMyRole } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import { DismissButton } from "@/components/DismissButton";

/**
 * What a dismissal of the trial notice is pinned to.
 *
 * A trial is bucketed by how close the end is, so the notice comes back each
 * time it gets materially closer: more than a week left, a week, three days,
 * the last day. An ended trial or plan is one version, and the seven-day
 * snooze at the call site is what brings it back.
 */
export function trialDismissVersion(s: Pick<TrialState, "phase" | "daysRemaining">): string {
  if (s.phase !== "trialing") return s.phase;
  const d = s.daysRemaining ?? 0;
  const bucket = d > 7 ? "early" : d > 3 ? "week" : d > 1 ? "soon" : "last";
  return `trialing:${bucket}`;
}

// BUILD-7 — the trial, said out loud.
//
// Shown for `trialing` and `expired` only. A paid org sees nothing, and neither
// does an organization created before trials existed (`none`) — those accounts
// were never offered a countdown and inventing one for them would be a
// surprise, not a feature.
//
// DISMISSIBLE SINCE 2026-10-03, BUT NEVER PERMANENTLY. It was not dismissible,
// on the reasoning that a countdown you can permanently hide is a countdown
// that ends without warning. That reasoning still holds, and is why the X
// does not hide it for good: the owner asked for notices he has read to go
// away ("it would be nice to dismiss or hide them if they are not
// necessary"), and the answer that keeps day fifteen from being a surprise is
// that a dismissal lasts only while nothing changes. See trialDismissVersion
// above: putting it away at 12 days left brings it back at 7, at 3 and on the
// last day, and an ended trial comes back weekly. Rule in src/lib/dismissible.ts.
//
// The call to action is role-aware: a tech cannot open billing, so telling them
// to "add a payment method" would hand them a button that refuses. They are
// told who to ask instead.
//
// ── ON A PHONE, THE EXPLANATION FOLDS. THE NOTICE DOES NOT. ───────────────
//
// MEASURED 2026-09-14 on the expired phase: 233px at 360, 217 at 390, 197 at
// 430, against 125 at 1280. Twenty of those pixels are the headline and twenty
// are the action; the rest is two paragraphs of reassurance wrapping to eight
// lines. That is 29% of a 360px screen, above EVERY authenticated page —
// including My Day, where it pushes the technician's route map down by more
// than the map had to spare.
//
// So below `sm` the two paragraphs sit behind "What this means" and the
// headline, the tone and the action stay exactly where they were. Folding is
// not dismissing: a folded banner still says "Your free trial has ended" on
// every screen; only the X puts it away, and only until the version or the
// snooze brings it back (above). What folds is the part you read once.

//
// ── NOT SHOWN TO A TECHNICIAN ─────────────────────────────────────────────
//
// It was, as "Your free trial has ended / Ask an owner to set up billing",
// about 85px above My Day on a phone (launch pass, 2026-10, recommendation 6).
// A tech can do nothing about it, and nothing about it changes their day: a
// lapsed plan pauses ADDING CLIENTS and the AI features, never the route
// (tests/paused-means-growth-not-the-whole-account.test.ts). The owner, office
// manager and dispatcher still see it; they are the people who can act or
// pass it on. Hidden while the role is still loading too, so a tech's phone
// never flashes it on the way in.
//
// ── THE COUNTDOWN IS THE OWNER'S ──────────────────────────────────────────
//
// R2-51: an office manager or dispatcher saw "14 days left… Ask an owner to
// set up billing" on every page, about a quarter of a 390px screen, for the
// whole trial. Only the owner can set up billing (`manage_org_billing`), so a
// countdown is chrome for the owner alone. Once the trial or plan has ENDED
// the others see it again: adding clients is paused for them too, and the
// notice is what explains the refusal and who to ask.
export function shownToRole(s: { phase: TrialState["phase"]; canManageBilling: boolean }): boolean {
  if (s.phase === "paid" || s.phase === "none") return false;
  // Ended is growthPausedFor()'s definition: expired or lapsed.
  return s.canManageBilling || s.phase === "expired" || s.phase === "lapsed";
}

export function TrialBanner() {
  const [showWhy, setShowWhy] = useState(false);
  const { role, orgId } = useMyRole();
  const fn = useServerFn(getTrialState);
  const { data } = useQuery({
    queryKey: ["trial", "state"],
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: role !== null && role !== "tech",
  });

  const shown = !!data && shownToRole(data);
  // Re-shows when the version changes (see trialDismissVersion) and, whatever
  // the phase, a week after it was put away.
  const { dismissed, dismiss } = useDismissed(
    "trial",
    shown && data ? trialDismissVersion(data) : null,
    { orgId, snoozeDays: 7 },
  );

  if (role === null || role === "tech") return null;
  if (!data) return null;
  // Narrows the phase for TRIAL_COPY below; shownToRole says the rest.
  if (data.phase === "paid" || data.phase === "none") return null;
  if (!shownToRole(data)) return null;
  if (dismissed) return null;

  const copy = TRIAL_COPY[data.phase];
  const warn = copy.tone === "warn";

  return (
    <div
      className={`flex items-start gap-x-1 border-b py-2 ps-4 pe-1 text-sm ${
        warn
          ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "bg-muted/50"
      }`}
    >
      {/* The notice itself, wrapping as it always did. `min-w-0` so it wraps
          beside the X rather than pushing it off the edge. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1">
        <Clock className={`h-4 w-4 shrink-0 ${warn ? "text-amber-600" : "text-muted-foreground"}`} />
        <span className="font-medium">{copy.headline(data)}</span>
        {data.canManageBilling ? (
          <Link to="/settings/billing" className="font-medium text-primary hover:underline">
            Set up billing
          </Link>
        ) : (
          <span className="text-muted-foreground">Ask an owner to set up billing.</span>
        )}
        <button
          type="button"
          onClick={() => setShowWhy((v) => !v)}
          aria-expanded={showWhy}
          className="inline-flex min-h-11 items-center gap-1 text-muted-foreground underline-offset-2 hover:underline sm:hidden"
        >
          What this means
          {showWhy ? (
            <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
        </button>
        <div className={`w-full ${showWhy ? "" : "hidden sm:block"}`}>
          <span className="text-muted-foreground">{copy.body}</span>
          {/* There used to be a second line here, GROWTH_PAUSED_NOTE, shown
              whenever growthPausedFor() was true. That is exactly the expired
              and lapsed phases, and the body for both already says the same
              thing word for word ("Everything you already have keeps running:
              your clients, jobs and routes, your invoices and history, and the
              customer portal"), so a paused tenant read the same sentence
              twice in one banner. The body carries the ratified definition;
              tests/paused-means-growth-not-the-whole-account.test.ts pins it. */}
        </div>
      </div>
      {/* Pulled into the banner's own padding so a 44px target does not make
          a one-line notice taller than it was. */}
      <DismissButton onClick={dismiss} label="Hide the trial notice" className="-my-2" />
    </div>
  );
}
