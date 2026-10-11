// Team-size ranges and caps (owner, 2026-10-09; spec NP-1, NP-10).
//
// Each plan covers a range of enabled users (`staff.active`): Launch 1–3,
// Growth 4–15, Scale 16+. The plan row stores only the top of its range,
// `platform_plans.max_team_size` (NULL = no cap). The bottom is not stored and
// not enforced: a small team may choose a bigger plan, so the floor is only
// for saying the range out loud, and it is derived from the plan below.
//
// The same sentences are produced by the database backstop
// (`enforce_team_size_cap` on staff), which catches the paths that never pass
// through a server function: `set_staff_active` and invite acceptance are both
// RPCs a signed-in owner can call directly.

export type TeamSizePlan = {
  id?: string;
  name: string;
  slug?: string | null;
  max_team_size: number | null;
  included_seats?: number | null;
  is_enterprise?: boolean | null;
};

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export function ordinal(n: number): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/** Self-serve plans in the order their ranges run: capped ones by cap, then
 *  uncapped. Enterprise, and a plan that includes nobody (a contact-us or
 *  legacy per-client row), has no range and is left out. */
export function byTeamSize<T extends TeamSizePlan>(plans: readonly T[]): T[] {
  return [...plans]
    .filter((p) => !p.is_enterprise && p.included_seats !== null)
    .sort((a, b) => {
      const am = a.max_team_size ?? Number.POSITIVE_INFINITY;
      const bm = b.max_team_size ?? Number.POSITIVE_INFINITY;
      if (am !== bm) return am - bm;
      return (a.included_seats ?? 0) - (b.included_seats ?? 0);
    });
}

/** The smallest team a plan's range starts at: one past the plan below it. */
export function teamSizeMin(plan: TeamSizePlan, plans: readonly TeamSizePlan[]): number {
  const ordered = byTeamSize(plans);
  const i = ordered.findIndex((p) => (plan.id ? p.id === plan.id : p.name === plan.name));
  if (i <= 0) return 1;
  const below = ordered[i - 1].max_team_size;
  return below == null ? 1 : below + 1;
}

/** "1–3 people", "4–15 people", "16+ people". */
export function teamSizeRange(plan: TeamSizePlan, plans: readonly TeamSizePlan[]): string {
  const min = teamSizeMin(plan, plans);
  if (plan.max_team_size == null) return `${min}+ people`;
  if (plan.max_team_size === min) return `${min} ${min === 1 ? "person" : "people"}`;
  return `${min}–${plan.max_team_size} people`;
}

/** The next plan up whose range is bigger than this one's, if any. */
export function nextPlanUp<T extends TeamSizePlan>(plan: TeamSizePlan, plans: readonly T[]): T | null {
  if (plan.max_team_size == null) return null;
  return byTeamSize(plans).find((p) => p.max_team_size == null || p.max_team_size > plan.max_team_size!) ?? null;
}

/** The smallest plan whose range holds `people`. */
export function smallestPlanFor<T extends TeamSizePlan>(people: number, plans: readonly T[]): T | null {
  const n = Math.max(1, people);
  return byTeamSize(plans).find((p) => p.max_team_size == null || p.max_team_size >= n) ?? null;
}

/**
 * Why one more enabled user is refused, or null when there is room.
 *
 * "Launch covers up to 3 people. To add a 4th, move to Growth." is the spec's
 * own wording (NP-10); the other plans follow the same pattern.
 */
export function addUserRefusal(
  plan: TeamSizePlan | null | undefined,
  enabledNow: number,
  plans: readonly TeamSizePlan[],
): string | null {
  if (!plan || plan.max_team_size == null) return null;
  if (enabledNow + 1 <= plan.max_team_size) return null;
  const next = nextPlanUp(plan, plans);
  const nth = ordinal(plan.max_team_size + 1);
  return next
    ? `${plan.name} covers up to ${plan.max_team_size} people. To add a ${nth}, move to ${next.name}.`
    : `${plan.name} covers up to ${plan.max_team_size} people. To add a ${nth}, contact us about a bigger plan.`;
}

/** Why a plan cannot be chosen for a team this size, or null when it can. */
export function choosePlanRefusal(
  plan: TeamSizePlan | null | undefined,
  enabledNow: number,
  plans: readonly TeamSizePlan[],
): string | null {
  if (!plan || plan.max_team_size == null) return null;
  if (enabledNow <= plan.max_team_size) return null;
  const fits = smallestPlanFor(enabledNow, plans);
  return (
    `${plan.name} covers up to ${plan.max_team_size} people, and ${enabledNow} are enabled on this account. ` +
    (fits ? `Choose ${fits.name}, or turn some users off first.` : "Turn some users off first.")
  );
}

/**
 * Does a cap apply to this organization right now?
 *
 * Only once a plan has been CHOSEN, which is what a paid status means. During a
 * trial the plan on the row is assigned automatically by team size
 * (`assign_billing_tier_for_org`), so "past the plan's max" has no meaning
 * yet: the cap is met at checkout instead, where a plan smaller than the team
 * cannot be chosen. A comped account is ours to size by hand.
 */
export function capApplies(org: {
  billing_status?: string | null;
  plan_status?: string | null;
  is_comped?: boolean | null;
}): boolean {
  if (org.is_comped) return false;
  const paid = new Set(["active", "past_due", "grace"]);
  return paid.has(String(org.billing_status ?? "")) || paid.has(String(org.plan_status ?? ""));
}
