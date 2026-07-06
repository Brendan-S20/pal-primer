// Canonical org billing state — every screen that renders "what plan is this
// org on" and "what's their status" MUST read from here so numbers agree.
//
// The band lookup is driven by the real platform_plans catalog (visible on
// /platform/plans), so if bands change in the DB every surface updates in one
// place.

type PlanRow = {
  id: string;
  name: string;
  slug: string;
  client_limit_min: number | null;
  client_limit_max: number | null;
  price_cents: number | null;
  price_per_client_cents: number | null;
  stripe_price_id: string | null;
  is_free: boolean;
  sort_order: number | null;
};

type OrgRow = {
  id: string;
  name: string;
  active_client_count: number | null;
  billing_status: string | null;
  plan_status: string | null;
  plan_id: string | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
  suspended_at: string | null;
  grace_expires_at: string | null;
};

export type BillingState = {
  orgId: string;
  orgName: string;
  activeClientCount: number;
  // The plan the org SHOULD be on for their current client count.
  requiredPlan: PlanRow | null;
  // The plan currently assigned in DB.
  currentPlan: PlanRow | null;
  // Preferred display: current if paid + healthy, else required.
  planName: string;
  planSlug: string | null;
  billingStatus: "free" | "active" | "past_due" | "grace" | "canceled" | "suspended";
  isPaidTier: boolean;
  priceCents: number | null;
  pricePerClientCents: number | null;
  monthlyEstimateCents: number | null; // final $ owed if per-client
  stripePriceId: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  currentPeriodEnd: string | null;
  suspendedAt: string | null;
  graceExpiresAt: string | null;
  // Free tier still applies while count ≤ freeLimit.
  freeLimit: number;
  needsUpgrade: boolean;
  overBandLimit: boolean;
  nextPlan: PlanRow | null;
};

const FREE_LIMIT = 3;

function planForClientCount(plans: PlanRow[], count: number): PlanRow | null {
  // Pick the smallest band whose [min,max] contains count.
  // Prefer non-free entries when count > FREE_LIMIT so "Free" and "Puppy" (both
  // 0–3) resolve deterministically: ≤3 → Free, >3 → first paid band.
  const sorted = [...plans].sort(
    (a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999),
  );
  if (count <= FREE_LIMIT) {
    return sorted.find((p) => p.is_free) ?? sorted[0] ?? null;
  }
  return (
    sorted.find(
      (p) =>
        !p.is_free &&
        (p.client_limit_min ?? 0) <= count &&
        (p.client_limit_max ?? Number.MAX_SAFE_INTEGER) >= count,
    ) ?? sorted.find((p) => !p.is_free && (p.client_limit_max == null)) ?? null
  );
}

function nextPlanAfter(plans: PlanRow[], current: PlanRow | null): PlanRow | null {
  if (!current) return null;
  const sorted = [...plans].sort(
    (a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999),
  );
  const idx = sorted.findIndex((p) => p.id === current.id);
  if (idx < 0) return null;
  return sorted.slice(idx + 1).find((p) => !p.is_free) ?? null;
}

/** Compute canonical billing state for a single org. Accepts an admin or
 *  authenticated Supabase client — reads are policy-safe for both. */
export async function getOrgBillingState(
  supabase: any,
  orgId: string,
): Promise<BillingState> {
  const [orgRes, plansRes] = await Promise.all([
    supabase
      .from("organizations")
      .select(
        "id, name, active_client_count, billing_status, plan_status, plan_id, stripe_customer_id, stripe_subscription_id, current_period_end, suspended_at, grace_expires_at",
      )
      .eq("id", orgId)
      .single(),
    supabase
      .from("platform_plans")
      .select(
        "id, name, slug, client_limit_min, client_limit_max, price_cents, price_per_client_cents, stripe_price_id, is_free, sort_order",
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
  ]);
  if (orgRes.error) throw new Error(orgRes.error.message);
  if (plansRes.error) throw new Error(plansRes.error.message);
  return buildBillingState(orgRes.data as OrgRow, (plansRes.data ?? []) as PlanRow[]);
}

/** Bulk variant — one query for orgs + one for plans, then compute in memory. */
export async function getBulkOrgBillingState(
  supabase: any,
  orgIds: string[] | null = null,
): Promise<Map<string, BillingState>> {
  const [orgsRes, plansRes] = await Promise.all([
    (async () => {
      let q = supabase
        .from("organizations")
        .select(
          "id, name, active_client_count, billing_status, plan_status, plan_id, stripe_customer_id, stripe_subscription_id, current_period_end, suspended_at, grace_expires_at",
        );
      if (orgIds) q = q.in("id", orgIds);
      return q;
    })(),
    supabase
      .from("platform_plans")
      .select(
        "id, name, slug, client_limit_min, client_limit_max, price_cents, price_per_client_cents, stripe_price_id, is_free, sort_order",
      )
      .eq("is_active", true)
      .order("sort_order", { ascending: true }),
  ]);
  if (orgsRes.error) throw new Error(orgsRes.error.message);
  if (plansRes.error) throw new Error(plansRes.error.message);
  const plans = (plansRes.data ?? []) as PlanRow[];
  const out = new Map<string, BillingState>();
  for (const o of (orgsRes.data ?? []) as OrgRow[]) {
    out.set(o.id, buildBillingState(o, plans));
  }
  return out;
}

function buildBillingState(o: OrgRow, plans: PlanRow[]): BillingState {
  const count = o.active_client_count ?? 0;
  const required = planForClientCount(plans, count);
  const current = o.plan_id ? plans.find((p) => p.id === o.plan_id) ?? null : null;

  // Reconcile status. Prefer explicit terminal states, fall back to derived.
  const raw = (o.billing_status || "").toLowerCase();
  let status: BillingState["billingStatus"];
  if (o.suspended_at) status = "suspended";
  else if (raw === "canceled") status = "canceled";
  else if (raw === "past_due") status = "past_due";
  else if (raw === "grace") status = "grace";
  else if (raw === "active" || o.stripe_subscription_id) status = "active";
  else status = "free";

  const isPaidTier = status === "active" || status === "past_due" || status === "grace";
  const displayPlan = isPaidTier && current ? current : required;

  // Effective $ for the display plan.
  const priceCents = displayPlan?.price_cents ?? null;
  const perClientCents = displayPlan?.price_per_client_cents ?? null;
  const monthlyEstimateCents = priceCents ??
    (perClientCents != null ? perClientCents * count : null);

  const overBandLimit = !!(
    displayPlan?.client_limit_max != null && count > displayPlan.client_limit_max
  );
  // Needs-upgrade = on free but over free limit, OR on a band whose max is exceeded.
  const needsUpgrade =
    (status === "free" && count > FREE_LIMIT) || overBandLimit;

  return {
    orgId: o.id,
    orgName: o.name,
    activeClientCount: count,
    requiredPlan: required,
    currentPlan: current,
    planName: displayPlan?.name ?? "Free",
    planSlug: displayPlan?.slug ?? null,
    billingStatus: status,
    isPaidTier,
    priceCents,
    pricePerClientCents: perClientCents,
    monthlyEstimateCents,
    stripePriceId: displayPlan?.stripe_price_id ?? null,
    stripeCustomerId: o.stripe_customer_id,
    stripeSubscriptionId: o.stripe_subscription_id,
    currentPeriodEnd: o.current_period_end,
    suspendedAt: o.suspended_at,
    graceExpiresAt: o.grace_expires_at,
    freeLimit: FREE_LIMIT,
    needsUpgrade,
    overBandLimit,
    nextPlan: nextPlanAfter(plans, displayPlan),
  };
}
