import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { ChevronDown, ChevronUp, Clock } from "lucide-react";
import { getTrialState } from "@/lib/trial.functions";
import { TRIAL_COPY } from "@/lib/trial";
import { useMyRole } from "@/hooks/useMyRole";

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
export function TrialBanner() {
  const [showWhy, setShowWhy] = useState(false);
  const { role } = useMyRole();
  const fn = useServerFn(getTrialState);
  const { data } = useQuery({
    queryKey: ["trial", "state"],
    queryFn: () => fn(),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: role !== null && role !== "tech",
  });

  if (role === null || role === "tech") return null;
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
  );
}
