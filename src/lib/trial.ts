// BUILD-7 — the trial lifecycle.
//
// ── WHAT WAS ACTUALLY WRONG ────────────────────────────────────────────────
//
// The marketing site has promised "14 day free trial, no credit card required"
// since launch, and its pricing FAQ says: "You either convert to Launch at $79
// per month or the account pauses. Nothing is deleted either way."
//
// The app had none of it. `bootstrap_organization` never set `trial_ends_at` or
// `plan_status = 'trialing'`; no organization has ever held a trial; and
// NOTHING in the tenant app gates on billing status at all — every reference is
// a platform-admin view or a metrics rollup. So every account that has ever
// signed up has unlimited free access, forever, and always did.
//
// The enum, the `trialing` branch in billing-state, and the announcement
// audience filter all existed. Like the weekly digest and the franchise rollup
// before it, the machinery was built and nothing ever set it in motion.
//
// ── WHY DAY 15 DOES NOT LOCK ANYONE OUT ────────────────────────────────────
//
// Owner decision, and the reason matters more than the choice: Stripe is not
// authorized yet, so there is no way to convert. A paywall whose only exit is
// a payment nobody can make is not a paywall, it is an outage — it would brick
// every existing account fourteen days from deploy, including the owner's own.
//
// So an expired trial is a STATE and a message, not a gate. `TRIAL_ENFORCEMENT`
// below is the single switch that turns it into one, and it flips when Stripe
// goes live. Deliberately one constant rather than scattered conditionals:
// enforcement that has to be assembled from six places is enforcement nobody
// can reason about before turning it on.

/** Mirrors TRIAL_DAYS in the marketing site's src/lib/site.ts.
 *
 *  Two repos cannot share a constant, so this is a copy — and a copy that
 *  drifts means the site promises fourteen days while the app grants seven.
 *  A test asserts the number against the published FAQ copy. */
export const TRIAL_DAYS = 14;

/**
 * Whether an expired trial actually restricts anything.
 *
 * FALSE until Stripe is authorized (BUILD-2 / IMP-6). See the header: with no
 * payment route, enforcement is an outage rather than a paywall.
 */
export const TRIAL_ENFORCEMENT = false;

export const TRIAL_PHASES = ["none", "trialing", "expired", "paid"] as const;
export type TrialPhase = (typeof TRIAL_PHASES)[number];

export type TrialInput = {
  planStatus: string | null | undefined;
  billingStatus?: string | null | undefined;
  trialEndsAt: string | null | undefined;
  hasSubscription?: boolean | null;
};

export type TrialState = {
  phase: TrialPhase;
  /** Whole days left, floored at 0. Null unless trialing. */
  daysRemaining: number | null;
  /** ISO day the trial ends, for "until 14 August" style copy. */
  endsOn: string | null;
  /** Does an expired trial restrict this org right now? */
  restricted: boolean;
};

const PAID_STATUSES = new Set(["active", "past_due", "grace"]);

/**
 * Which phase an organization is in.
 *
 * `now` is injected so this is testable and so a caller can evaluate it in the
 * organization's own timezone rather than the server's.
 */
export function trialStateFor(org: TrialInput, now: Date = new Date()): TrialState {
  const status = (org.planStatus || org.billingStatus || "").toLowerCase();

  // A subscription outranks whatever the status column says. Statuses are
  // written by several paths and can lag; a live subscription is a fact.
  if (org.hasSubscription || PAID_STATUSES.has(status)) {
    return { phase: "paid", daysRemaining: null, endsOn: null, restricted: false };
  }

  const endsAt = org.trialEndsAt ? Date.parse(org.trialEndsAt) : NaN;
  if (!org.trialEndsAt || Number.isNaN(endsAt)) {
    // No trial was ever started. Every organization created before BUILD-7 is
    // here, and they are deliberately left alone: retro-fitting a clock that
    // expires in fourteen days onto an account somebody has been using for
    // months would be a surprise, not a migration.
    return { phase: "none", daysRemaining: null, endsOn: null, restricted: false };
  }

  const msLeft = endsAt - now.getTime();
  if (msLeft <= 0) {
    return {
      phase: "expired",
      daysRemaining: null,
      endsOn: org.trialEndsAt.slice(0, 10),
      restricted: TRIAL_ENFORCEMENT,
    };
  }

  return {
    phase: "trialing",
    // Ceiling, not floor: with 18 hours left an owner should read "1 day left",
    // not "0 days left" on an account that still works. Rounding the wrong way
    // here is how a banner tells somebody their trial ended before it did.
    daysRemaining: Math.max(0, Math.ceil(msLeft / 86_400_000)),
    endsOn: org.trialEndsAt.slice(0, 10),
    restricted: false,
  };
}

/**
 * May this organization use AI features?
 *
 * OWNER DECISION: paid only. AI runs on HoundStack's own keys and there is no
 * usage metering yet — that is BUILD-2, which is blocked on Stripe — so a trial
 * with AI is unbounded spend on our account with nothing to detect it. Given
 * the choice between a better demo and an uncapped bill, the owner chose the
 * bill.
 *
 * Note this returns false for `none` too. An organization created before
 * BUILD-7 is not paying either, and carving out an exception for them would be
 * a loophole that never closes.
 */
export function aiAvailableFor(state: TrialState): boolean {
  return state.phase === "paid";
}

export const TRIAL_COPY: Record<
  Exclude<TrialPhase, "paid" | "none">,
  { headline: (s: TrialState) => string; body: string; tone: "info" | "warn" }
> = {
  trialing: {
    headline: (s) =>
      s.daysRemaining === 1
        ? "Last day of your free trial"
        : `${s.daysRemaining} days left in your free trial`,
    body: "Everything is unlocked except the AI features, which need a paid plan. Nothing is charged automatically and no card is on file.",
    tone: "info",
  },
  expired: {
    headline: () => "Your free trial has ended",
    body: "Your account still works and nothing has been deleted. Add a payment method when you're ready — we'll tell you before anything changes.",
    tone: "warn",
  },
};

/** Why AI is unavailable, in words a tenant can act on. Never "unavailable". */
export function aiUnavailableReason(state: TrialState): string | null {
  if (aiAvailableFor(state)) return null;
  return state.phase === "trialing"
    ? "AI features need a paid plan. They're the one thing the free trial doesn't include, because every request costs us real money to run."
    : "AI features need a paid plan.";
}
