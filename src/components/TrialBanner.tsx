import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Clock } from "lucide-react";
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

export function TrialBanner() {
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
      <span className="text-muted-foreground">{copy.body}</span>
      {/* The ratified definition, stated on the surface a paused tenant sees.
          Derived from growthPausedFor rather than `restricted`, because the
          database gate that does the pausing is not grandfathered and
          `restricted` is — reading the latter would tell a grandfathered org
          nothing is paused while their next customer is refused. */}
      {growthPausedFor(data) ? (
        <span className="w-full text-xs text-muted-foreground">{GROWTH_PAUSED_NOTE}</span>
      ) : null}
      {data.canManageBilling ? (
        <Link to="/settings/billing" className="font-medium text-primary hover:underline">
          Set up billing
        </Link>
      ) : (
        <span className="text-muted-foreground">Ask an owner to set up billing.</span>
      )}
    </div>
  );
}
