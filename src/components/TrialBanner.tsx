import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { getTrialState } from "@/lib/trial.functions";
import { TRIAL_COPY, GROWTH_PAUSED_NOTE, growthPausedFor } from "@/lib/trial";

// BUILD-7 — the trial, said out loud.
//
// Shown for `trialing` and `expired` only. A paid org sees nothing, and neither
// does an organization created before trials existed (`none`) — those accounts
// were never offered a countdown and inventing one for them would be a
// surprise, not a feature.
//
// Not dismissible. A countdown you can permanently hide is a countdown that
// ends without warning, and the whole point is that nobody is surprised on day
// fifteen. It is one quiet line rather than a modal, so it can sit there for
// two weeks without becoming something people learn to click past.
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
// headline, the tone and the action stay exactly where they were. That is not
// the dismissal the note above forbids: a dismissed banner is one you stop
// seeing, and this one still says "Your free trial has ended" on every screen,
// every time, with no way to make it stop. What folds is the part you read
// once.

export function TrialBanner() {
  const [showWhy, setShowWhy] = useState(false);
  const fn = useServerFn(getTrialState);
  const { data } = useQuery({
    queryKey: ["trial", "state"],
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (!data) return null;
  if (data.phase === "paid" || data.phase === "none") return null;

  const copy = TRIAL_COPY[data.phase];
  const warn = copy.tone === "warn";

  return (
    <div
      className={`flex flex-wrap items-center gap-x-3 gap-y-1 border-b px-4 py-2 text-sm ${
        warn
          ? "border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-200"
          : "bg-muted/50"
      }`}
    >
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
        {/* The ratified definition, stated on the surface a paused tenant sees.
            Derived from growthPausedFor rather than `restricted`, because the
            database gate that does the pausing is not grandfathered and
            `restricted` is — reading the latter would tell a grandfathered org
            nothing is paused while their next customer is refused. */}
        {growthPausedFor(data) ? (
          <span className="mt-1 block text-xs text-muted-foreground">{GROWTH_PAUSED_NOTE}</span>
        ) : null}
      </div>
    </div>
  );
}
