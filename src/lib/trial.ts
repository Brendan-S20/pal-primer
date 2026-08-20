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
// WHAT DAY 15 DOES NOW, STATED ACCURATELY (corrected 2026-08-20).
//
// It computes `restricted`. It does not restrict.
//
// `TRIAL_ENFORCEMENT` was flipped to true on 2026-08-16 under a commit message
// saying trials enforce. They do not, because the half this constant was
// designed to switch was never built: `restricted` is written in all five
// branches below, serialized to the browser by trial.functions.ts, and read by
// NOTHING. `git log -S'.restricted' -- src/` is empty for the life of the repo,
// so it was never wired and then unwired — it has always been inert. Flipping
// the constant back to false today would change no observable behaviour either.
//
// The one thing an expired trial really loses is AI, and that is `aiAvailableFor`
// gating on `phase === "paid"` (below), which is independent of this constant
// and works whether it is true or false.
//
// Deliberately still ungated, and each for a reason worth keeping: invoicing and
// card payments (blocking those stops a business collecting the money it needs
// to pay us), the customer portal (a HoundStack billing problem must not show up
// as a broken business to the tenant's own customers), routing (the truck is
// already out), and read access to data the tenant owns — the published FAQ
// promises "nothing is deleted either way", and MASTER_BRIEF §3114 makes the
// same point about relationships you can enter and cannot exit.
//
// SETTLED 2026-08-20, and this is the part to read first. "The account pauses"
// means GROWTH pauses: an expired trial cannot take on a NEW customer, keeps
// everything it already has, and is not frozen in any other way. See
// growthPausedFor below for the authoritative list, and note where the rule
// actually lives — `org_can_add_client`, a database trigger that has been
// enforcing exactly this since 20260701164146, before any of this file existed.
//
// The owner ratified that gate rather than extending it, and explicitly
// declined a broader freeze until real usage and support load argue for one.
//
// So `restricted` stays unwired BY DECISION. It was built for the broader
// freeze; there is no broader freeze. It also could not be used for the copy
// even if we wanted to, because it is grandfathered by TRIAL_ENFORCEMENT_FROM
// and the database gate is not — it would tell a grandfathered org that nothing
// is paused while the database refuses their next customer.
//
// The grandfather clause is real but currently empty: enforcementApplies exempts
// organizations created before TRIAL_ENFORCEMENT_FROM, and every such org today
// is already `paid`. If a gate does land later, revisit that date — anyone who
// signed up between 2026-08-16 and the gate shipping did so under "a message,
// not a lock", which is exactly what the constant's own comment says must not
// happen to them.

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
    body: "Adding new customers and the AI features need an active plan. Everything you already have keeps running: your clients, jobs and routes, your invoices and history, and the customer portal. Nothing has been deleted.",
    tone: "warn",
  },
  trialing: {
    headline: (s) =>
      s.daysRemaining === 1
        ? "Last day of your free trial"
        : `${s.daysRemaining} days left in your free trial`,
    // "Except the AI features" was the whole story while the trial is running,
    // and stops being it the day it ends: adding a customer goes too. Said here
    // so the change is not a surprise on day 15.
    body: "Everything is unlocked except the AI features, which need a paid plan. When the trial ends you keep everything you have, but adding new customers will need a plan too. Nothing is charged automatically and no card is on file.",
    tone: "info",
  },
  expired: {
    headline: () => "Your free trial has ended",
    // Corrected 2026-08-20. This used to end "we'll tell you before anything
    // changes", which was false twice over: something had ALREADY changed by
    // the time this banner appears -- org_can_add_client returns false the
    // moment trial_ends_at passes, so new customers are refused by a database
    // trigger -- and there is no trial-expiry email in the repo to have told
    // them with. A banner that promises a warning it cannot send, about a
    // change that already happened, is worse than one that simply says what is
    // true now.
    body: "Adding new customers and the AI features need an active plan. Everything you already have keeps running: your clients, jobs and routes, your invoices and history, and the customer portal. Nothing has been deleted.",
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
 * There is deliberately NO broader account freeze, and there is not to be one
 * until real usage and support load say otherwise.
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
 * actually happens, and `restricted` stays unwired — now by decision rather
 * than by oversight.
 */
export function growthPausedFor(state: TrialState): boolean {
  return state.phase === "expired" || state.phase === "lapsed";
}

/** What a paused account can and cannot do, in one sentence, for the banner. */
export const GROWTH_PAUSED_NOTE =
  "Paused means new customers only. Everything you already have keeps running: " +
  "your clients, jobs and routes, your invoices and history, and the customer portal.";

/** Why AI is unavailable, in words a tenant can act on. Never "unavailable". */
export function aiUnavailableReason(state: TrialState): string | null {
  if (aiAvailableFor(state)) return null;
  if (state.phase === "trialing") {
    return "AI features need a paid plan. They're the one thing the free trial doesn't include, because every request costs us real money to run.";
  }
  if (state.phase === "lapsed") {
    return "AI features need an active plan. Yours has ended, so AI and adding new customers are paused — everything you already have still works.";
  }
  return "AI features need a paid plan.";
}
