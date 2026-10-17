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
// ── WHY DAY 15 DID NOT LOCK ANYONE OUT, UNTIL 2026-08-16 ───────────────────
//
// Kept in the past tense on purpose. This was the reasoning while
// TRIAL_ENFORCEMENT was false, and it is why the switch existed at all:
//
//   Owner decision, and the reason matters more than the choice: Stripe is not
//   authorized yet, so there is no way to convert. A paywall whose only exit
//   is a payment nobody can make is not a paywall, it is an outage — it would
//   brick every existing account fourteen days from deploy, including the
//   owner's own.
//
//   So an expired trial is a STATE and a message, not a gate.
//
// That condition has since been met. The single-constant design is the part
// that survives unchanged, and it earned itself: enforcement that has to be
// assembled from six places is enforcement nobody can reason about before
// turning it on — and turning it on was one line plus a date.
//
// WHAT DAY 15 DOES NOW (owner decision, 2026-10-09; spec NP-12).
//
// It LOCKS. A trial past day 14 with no plan, and a cancelled plan once it has
// ended, reach the plan picker and checkout and nothing else; the data is kept
// for 30 days, and a cancelled plan may export it for those 30 days. Choosing
// a plan unlocks the account at once. The lock reads `restricted` from
// trialStateFor below, through src/lib/account-lock.ts, and is enforced by the
// `_authenticated` layout, a global server-function middleware (src/start.ts)
// and the customer portal.
//
// History, kept because it explains the shape. From 2026-08-16 to 2026-10-09
// `restricted` was computed in every branch below and read by NOTHING: the
// owner had ratified (2026-08-20) that "the account pauses" meant only that
// GROWTH paused -- `org_can_add_client`, a database trigger, refusing a new
// customer -- and explicitly declined a broader freeze. On 2026-10-09 the owner
// chose the broader freeze. The database gate on new clients still exists and
// still fires first; growthPausedFor below still describes it.
//
// The grandfather clause still holds: enforcementApplies exempts organizations
// created before TRIAL_ENFORCEMENT_FROM, so nobody who signed up before the
// trial existed is locked by it. Comped accounts are never locked
// (account-lock.ts).

/** Mirrors TRIAL_DAYS in the marketing site's src/lib/site.ts.
 *
 *  Two repos cannot share a constant, so this is a copy — and a copy that
 *  drifts means the site promises fourteen days while the app grants seven.
 *  A test asserts the number against the published FAQ copy. */
export const TRIAL_DAYS = 14;

/**
 * Whether an expired trial actually restricts anything.
 *
 * TRUE since 2026-08-16. The condition this constant was written to wait for —
 * "FALSE until Stripe is authorized (BUILD-2 / IMP-6)" — has been met: the live
 * catalog is armed, checkout works, and a tenant whose trial ends now has a way
 * to pay. The paragraph above about a paywall with no exit still describes why
 * it was false; it no longer describes today.
 *
 * Turned on while the blast radius was ZERO, which was deliberate and is worth
 * recording: on the day it flipped there were three organizations, all of them
 * demo, none with a subscription, none expired and none trialing. Every day it
 * stayed off was a day a fourteen-day trial did not actually end, and the cost
 * of flipping it only ever goes up.
 */
export const TRIAL_ENFORCEMENT = true;

/**
 * Organizations created BEFORE this date are never restricted by an expired
 * trial, however long ago it expired.
 *
 * Owner call, 2026-08-16: enforce for new signups only. Nobody who signed up
 * under "an expired trial is a message, not a gate" gets a different answer
 * because we changed our minds afterwards — the account keeps working, exactly
 * as it did the day they made it.
 *
 * The set is empty today, which is the point: it costs nothing now and it is
 * the difference between an early customer keeping their account and losing it.
 * An ISO date rather than a list of ids, because a list is a thing somebody has
 * to maintain and a date is a thing that answers for itself.
 */
export const TRIAL_ENFORCEMENT_FROM = "2026-08-16";

/**
 * Does enforcement reach this organization?
 *
 * Fails OPEN when `createdAt` is absent, and that direction is chosen rather
 * than defaulted: a caller that forgets the field should let somebody in, not
 * lock them out of an account they are paying for. The risk of failing open —
 * a call site quietly disabling enforcement — is covered by a test that
 * asserts every trialStateFor caller passes createdAt, because that is a
 * question the type system will not ask on an optional field.
 */
export function enforcementApplies(createdAt: string | null | undefined): boolean {
  if (!TRIAL_ENFORCEMENT) return false;
  if (!createdAt) return false;
  return createdAt.slice(0, 10) >= TRIAL_ENFORCEMENT_FROM;
}

export const TRIAL_PHASES = ["none", "trialing", "expired", "lapsed", "paid"] as const;
export type TrialPhase = (typeof TRIAL_PHASES)[number];

export type TrialInput = {
  planStatus: string | null | undefined;
  billingStatus?: string | null | undefined;
  trialEndsAt: string | null | undefined;
  hasSubscription?: boolean | null;
  /** organizations.created_at. Decides whether enforcement reaches this
   *  account at all — see TRIAL_ENFORCEMENT_FROM. Optional so the many tests
   *  that predate grandfathering still compile, and fail-open when missing. */
  createdAt?: string | null;
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

// Read from BOTH columns, not one-or-the-other.
//
// This was `planStatus || billingStatus`, which never fell through, because
// plan_status is NOT NULL DEFAULT 'free' — the fallback could not fire. And
// 'grace' and 'suspended' exist ONLY in org_billing_status; org_plan_status has
// no such labels. So the 'grace' entry here was unreachable, and a platform
// admin granting a grace period (which writes billing_status='grace' and leaves
// plan_status alone) got an organization this function called `none` — AI
// switched off for the tenant they had just extended service to.
const PAID_STATUSES = new Set(["active", "past_due", "grace"]);

// Someone decided these. They outrank everything below, including a stored
// subscription id, and they are checked FIRST so the failure direction is
// "denied AI we should have allowed" rather than "billed HoundStack for an
// account that is not paying".
const ENDED_STATUSES = new Set(["canceled", "suspended"]);

/**
 * Which phase an organization is in.
 *
 * `now` is injected so this is testable and so a caller can evaluate it in the
 * organization's own timezone rather than the server's.
 */
export function trialStateFor(org: TrialInput, now: Date = new Date()): TrialState {
  const plan = (org.planStatus || "").toLowerCase();
  const billing = (org.billingStatus || "").toLowerCase();
  const either = (s: Set<string>) => s.has(plan) || s.has(billing);

  // Cancelled or suspended, whichever column says so.
  //
  // This has to come before the subscription check below, because
  // stripe_subscription_id SURVIVES cancellation: the platform webhook's
  // customer.subscription.deleted branch writes { stripe_subscription_id:
  // sub.id, plan_status: 'canceled' } — it re-writes the id rather than
  // clearing it, and only refreshBillingStatus ever nulls it, which requires
  // the cancelled tenant to go and open Settings → Billing.
  //
  // With the old ordering a cancelled organization read as `paid` forever: its
  // AI receptionist kept answering every inbound message on HoundStack's own
  // model keys, unmetered, with no banner to tell anyone. Suspension was worse
  // — suspendTenant writes billing_status='suspended' and never touches
  // plan_status, so a tenant suspended FOR FRAUD kept its plan_status='active'
  // and kept spending our money.
  if (either(ENDED_STATUSES)) {
    return {
      phase: "lapsed",
      daysRemaining: null,
      endsOn: null,
      // A suspension is a decision already enforced elsewhere, so it restricts
      // regardless of the trial-enforcement switch. A cancellation waits for
      // the same switch as an expired trial: with no way to pay yet, cutting
      // someone off is an outage, not a paywall.
      restricted:
        billing === "suspended" || plan === "suspended" || enforcementApplies(org.createdAt),
    };
  }

  // A live subscription outranks a lagging status column. It genuinely can
  // lead: createPlanSubscription writes stripe_subscription_id at checkout,
  // before the webhook that sets plan_status arrives. Now that a cancellation
  // is caught above, the id can only mean "paying".
  if (org.hasSubscription || either(PAID_STATUSES)) {
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
      restricted: enforcementApplies(org.createdAt),
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
  lapsed: {
    // Deliberately not the `expired` copy. Someone who cancelled a paid plan
    // being told "your free trial has ended" would reasonably conclude the
    // product has lost track of what they paid for.
    headline: () => "Your plan has ended",
    body: "Your account is locked until you choose a plan. You can export your data for 30 days after canceling.",
    tone: "warn",
  },
  trialing: {
    headline: (s) =>
      s.daysRemaining === 1
        ? "Last day of your free trial"
        : `${s.daysRemaining} days left in your free trial`,
    // Adding a customer stops the day the trial ends. Said here so the change
    // is not a surprise on day 15. (It also said "except the AI features"
    // until 2026-10-03, when everything a trial can reach stopped using AI:
    // the receptionist is an add-on and marketing posts are not live.)
    body: "Everything is unlocked. If you don't choose a plan by the end of the trial, the account is locked until you do, and your data is kept for 30 days. Nothing is charged automatically and no card is on file.",
    tone: "info",
  },
  expired: {
    headline: () => "Your free trial has ended",
    // NP-12 (2026-10-09). This banner and the plan picker are all a locked
    // account sees. Until then it said everything kept running, which was
    // true of the growth-only pause and is not true of the lock.
    body: "Your account is locked. Choose a plan to unlock it. Your data is kept for 30 days.",
    tone: "warn",
  },
};

/**
 * IS GROWTH PAUSED FOR THIS ORGANIZATION?
 *
 * The ratified meaning of "the account pauses" (owner decision, 2026-08-20):
 * GROWTH is paused, not the account. Concretely, and this list is the whole of
 * it —
 *
 *   paused:      taking on a NEW customer.
 *   governed
 *   separately:  AI, by aiAvailableFor and the plan's action allowance.
 *   NOT paused:  existing clients, jobs and routes stay usable; billing and
 *                history stay accessible; nothing existing is locked or hidden;
 *                invoicing, card payments, the portal, the field app and every
 *                read keep working.
 *
 * SUPERSEDED 2026-10-09 for the account as a whole: the owner chose the
 * broader freeze (NP-12), which is the account lock in src/lib/account-lock.ts.
 * This function still describes the database's own gate on new clients, which
 * fires for every expired or lapsed org, grandfathered or not.
 *
 * This mirrors `org_can_add_client`, which is where the rule is actually
 * enforced — a BEFORE INSERT trigger on public.clients, live since
 * 20260701164146, whose predicate allows `trialing` only while
 * `trial_ends_at > now()` and otherwise falls through to false. The mapping to
 * phases is exact: `paid` and an unexpired `trialing` may grow; `expired` and
 * `lapsed` may not.
 *
 * WHY THIS IS NOT `restricted`. `restricted` was designed for the broader
 * freeze, is gated on TRIAL_ENFORCEMENT and grandfathered by
 * TRIAL_ENFORCEMENT_FROM, and the database gate honours neither. Deriving copy
 * from it would tell a grandfathered org that nothing is paused while the
 * database refuses their next customer. So the copy reads THIS, which is what
 * actually happens. (`restricted` is now read, by the account lock.)
 */
export function growthPausedFor(state: TrialState): boolean {
  return state.phase === "expired" || state.phase === "lapsed";
}

/** Why AI is unavailable, in words a tenant can act on. Never "unavailable". */
export function aiUnavailableReason(state: TrialState): string | null {
  if (aiAvailableFor(state)) return null;
  if (state.phase === "trialing") {
    return "AI features need a paid plan. They're the one thing the free trial doesn't include, because every request costs us real money to run.";
  }
  if (state.phase === "lapsed") {
    return "AI features need an active plan. Yours has ended, so the account is locked until you choose one.";
  }
  return "AI features need a paid plan.";
}
