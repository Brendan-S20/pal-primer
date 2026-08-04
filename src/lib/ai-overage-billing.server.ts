// BUILD-2 — turning a month's AI overage into a line on the org's next invoice.
//
// ── WHY AN INVOICE ITEM AND NOT A SUBSCRIPTION QUANTITY ───────────────────
//
// The repo already has a quantity-driven overage: `seat-sync.server.ts` keeps a
// licensed subscription item's `quantity` equal to the org's staff count over
// its included seats. That works because seats are a LEVEL — the current
// answer is the whole answer, and setting it again is harmless.
//
// AI usage is CUMULATIVE within a period and must return to zero at the
// boundary. Modelling that as a quantity means a reset step, and a reset that
// does not happen bills last month's overage again this month, and the month
// after, forever, with the customer's invoice quietly wrong each time. There
// is no reset to forget here: one closed month produces one invoice item, once.
//
// ── HOW IT CANNOT BILL TWICE ──────────────────────────────────────────────
//
// Three guards, because this writes a charge to a real customer:
//
//   1. only CLOSED months are eligible — the current month is never billed;
//   2. `ai_usage_periods.billed_at` is claimed by a conditional update BEFORE
//      Stripe is called, so two concurrent runs cannot both proceed;
//   3. the Stripe call carries an idempotency key derived from the org and the
//      month, so even a retry that got past (2) — a crash between the claim and
//      the call, then a re-run after the claim was rolled back — returns the
//      SAME invoice item rather than creating a second one.
//
// (2) before the Stripe call rather than after is deliberate and is the
// opposite of what feels safe. Claiming first risks a month being marked
// billed when the charge never landed; claiming last risks charging twice.
// Between "we forgot to bill them" and "we billed them twice", the first is
// recoverable from the event log and the second is a refund, an apology, and a
// support ticket. The idempotency key is what makes the risk of (2) small: a
// re-run reaches the same Stripe object.

import { orgLocalDay, DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
// Top-level, not `await import()` per call. client.server.ts's own note says a
// top-level import is safe in another .server.ts module — and this runs once
// per org in a loop, so re-resolving the module every iteration bought nothing
// but latency. It also removes a real hazard: two concurrent calls each
// starting their own dynamic import of the same module is a race, and under
// vitest it is the race that hands one of them an unmocked client.
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { makeStripe } from "@/lib/stripe-client.server";

export type OverageOutcome =
  | { billed: true; orgId: string; periodMonth: string; cents: number; invoiceItemId: string }
  | { skipped: string; orgId: string; periodMonth?: string };

/** The org-local month that has NOT closed yet. Everything before it is fair
 *  game; this one is still accruing. */
export function currentOrgMonth(tz: string, now: Date = new Date()): string {
  return `${orgLocalDay(now, tz).slice(0, 7)}-01`;
}

type PeriodRow = {
  organization_id: string;
  period_month: string;
  actions: number;
};

/**
 * Bill one closed month for one org.
 *
 * Never throws — a Stripe failure for one org must not stop the run for the
 * rest. Returns why it skipped, so the nightly summary can say so.
 */
export async function billOrgAiOverage(row: PeriodRow): Promise<OverageOutcome> {
  const orgId = row.organization_id;
  const periodMonth = row.period_month;

  const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) return { skipped: "stripe_not_configured", orgId, periodMonth };

  const admin = supabaseAdmin as never as {
    from: (t: string) => {
      select: (c: string) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          maybeSingle: () => Promise<{ data: unknown }>;
          eq: (
            k: string,
            v: unknown,
          ) => {
            is: (
              k: string,
              v: null,
            ) => {
              select: (c: string) => Promise<{ data: unknown[] | null }>;
            };
          };
        };
      };
      update: (p: Record<string, unknown>) => {
        eq: (
          k: string,
          v: unknown,
        ) => {
          eq: (
            k: string,
            v: unknown,
          ) => {
            is: (
              k: string,
              v: null,
            ) => {
              select: (c: string) => Promise<{ data: unknown[] | null }>;
            };
          };
        };
      };
    };
  };

  // The allowance and rate that applied to this org. Read from the plan rather
  // than stored on the period: a plan change mid-month is rare, and pricing
  // the closed month at the CURRENT plan is the reading that favours a
  // customer who upgraded and the one that is simplest to explain.
  const { data: org } = await admin
    .from("organizations")
    .select("stripe_customer_id, stripe_subscription_id, timezone, plan_id")
    .eq("id", orgId)
    .maybeSingle();
  const o = org as {
    stripe_customer_id?: string | null;
    stripe_subscription_id?: string | null;
    plan_id?: string | null;
  } | null;
  if (!o?.stripe_customer_id) return { skipped: "no_stripe_customer", orgId, periodMonth };
  if (!o.plan_id) return { skipped: "no_plan", orgId, periodMonth };

  const { data: plan } = await admin
    .from("platform_plans")
    .select("ai_actions_included, ai_overage_cents_per_action")
    .eq("id", o.plan_id)
    .maybeSingle();
  const p = plan as {
    ai_actions_included?: number | null;
    ai_overage_cents_per_action?: number | null;
  } | null;
  const included = p?.ai_actions_included;
  const rate = p?.ai_overage_cents_per_action;
  // Unlimited plans and plans with no overage rate are metered but not billed.
  if (included == null || rate == null)
    return { skipped: "plan_has_no_overage", orgId, periodMonth };

  const overActions = Math.max(0, (row.actions ?? 0) - included);
  const cents = overActions * rate;
  if (cents <= 0) {
    // Still marked billed. A month with no overage that stays unbilled is
    // re-examined by every future run for ever, and the run's own "how many
    // months are outstanding" number becomes meaningless.
    await admin
      .from("ai_usage_periods")
      .update({ billed_at: new Date().toISOString(), billed_actions: 0, billed_cents: 0 })
      .eq("organization_id", orgId)
      .eq("period_month", periodMonth)
      .is("billed_at", null)
      .select("organization_id");
    return { skipped: "no_overage", orgId, periodMonth };
  }

  // GUARD 2 — claim before charging. See the header for why this order.
  const { data: claimed } = await admin
    .from("ai_usage_periods")
    .update({
      billed_at: new Date().toISOString(),
      billed_actions: overActions,
      billed_cents: cents,
    })
    .eq("organization_id", orgId)
    .eq("period_month", periodMonth)
    .is("billed_at", null)
    .select("organization_id");
  if (!claimed || claimed.length === 0) return { skipped: "already_billed", orgId, periodMonth };

  const stripe = await makeStripe(secret);

  const monthLabel = new Date(`${periodMonth}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

  try {
    const item = await stripe.invoiceItems.create(
      {
        customer: o.stripe_customer_id,
        ...(o.stripe_subscription_id ? { subscription: o.stripe_subscription_id } : {}),
        amount: cents,
        currency: "usd",
        // The line the customer reads. It names the month, the count and the
        // allowance it went past, because "AI overage $12.40" on its own is
        // the kind of line that generates a support ticket.
        description:
          `AI usage — ${monthLabel}: ${overActions.toLocaleString()} action${overActions === 1 ? "" : "s"} ` +
          `beyond the ${included.toLocaleString()} included`,
        metadata: {
          kind: "ai_overage",
          organization_id: orgId,
          period_month: periodMonth,
          actions_over: String(overActions),
          actions_included: String(included),
        },
      },
      // GUARD 3.
      { idempotencyKey: `ai-overage-${orgId}-${periodMonth}` },
    );

    await admin
      .from("ai_usage_periods")
      .update({ stripe_invoice_item_id: item.id })
      .eq("organization_id", orgId)
      .eq("period_month", periodMonth)
      .is("stripe_invoice_item_id", null)
      .select("organization_id");

    return { billed: true, orgId, periodMonth, cents, invoiceItemId: item.id };
  } catch (e) {
    // The claim stands. A retry hits the same idempotency key and either
    // succeeds or fails the same way; what it cannot do is bill twice. Logged
    // loudly because an org whose claim stuck without a charge is money we
    // will not otherwise notice we are owed.
    console.error("[ai-overage] stripe invoice item failed", orgId, periodMonth, e);
    return { skipped: `stripe_error: ${(e as Error).message}`, orgId, periodMonth };
  }
}

/**
 * Bill every closed, unbilled month across every org.
 *
 * Safe to run daily. The vast majority of runs find nothing: only the first run
 * after a month boundary has anything to do, and once a month is billed its
 * `billed_at` takes it out of the query for good.
 */
export async function runAiOverageBilling(): Promise<{
  billed: number;
  centsTotal: number;
  skipped: number;
  outcomes: OverageOutcome[];
}> {
  const admin = supabaseAdmin as never as {
    from: (t: string) => {
      select: (c: string) => {
        is: (k: string, v: null) => Promise<{ data: unknown[] | null }>;
      };
    };
  };

  const { data: rows } = await admin
    .from("ai_usage_periods")
    .select("organization_id, period_month, actions")
    .is("billed_at", null);

  const outcomes: OverageOutcome[] = [];
  let billed = 0;
  let centsTotal = 0;

  for (const raw of (rows ?? []) as PeriodRow[]) {
    // GUARD 1 — the current month is still accruing. Each org's month is its
    // OWN month: on 1 August at 02:00 UTC a Chicago org is still in July, and
    // billing them then would cut their month short by seven hours of usage
    // and then bill the remainder again as a second July.
    const { data: org } = await (
      supabaseAdmin as never as {
        from: (t: string) => {
          select: (c: string) => {
            eq: (k: string, v: unknown) => { maybeSingle: () => Promise<{ data: unknown }> };
          };
        };
      }
    )
      .from("organizations")
      .select("timezone")
      .eq("id", raw.organization_id)
      .maybeSingle();
    const tz = (org as { timezone?: string | null } | null)?.timezone || DEFAULT_ORG_TIMEZONE;
    if (raw.period_month >= currentOrgMonth(tz)) {
      outcomes.push({
        skipped: "month_still_open",
        orgId: raw.organization_id,
        periodMonth: raw.period_month,
      });
      continue;
    }

    const outcome = await billOrgAiOverage(raw);
    outcomes.push(outcome);
    if ("billed" in outcome) {
      billed++;
      centsTotal += outcome.cents;
    }
  }

  return { billed, centsTotal, skipped: outcomes.length - billed, outcomes };
}
