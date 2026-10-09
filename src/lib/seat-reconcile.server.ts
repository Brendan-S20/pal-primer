// When seat periods are charged. What a seat is and how it is charged is in
// seat-rule.ts; the charge itself, exactly once, is seat-charges.server.ts.
// This file decides WHICH periods are due, at the three moments that matter:
//
//   chargeSeatsOnRenewalInvoice   Stripe has drafted a monthly renewal
//                                 invoice: the period that just closed goes
//                                 on it, as its own dated line.
//   chargeFinalSeatPeriods        a subscription ended: its final period,
//                                 cut at the moment it ended, is charged once.
//   sweepSeatCharges              nightly: every subscription's closed months
//                                 not yet charged -- a yearly plan's month, or
//                                 a renewal the webhook missed -- each on an
//                                 invoice of its own. It also runs the
//                                 changeover on every subscription the first
//                                 night after this ships.
//
// Never throws past its own summary: one org's failure is counted and the
// rest still run.

import type Stripe from "stripe";
import { isDemoOrganization } from "@/lib/demo-org";
import { makeStripe } from "@/lib/stripe-client.server";
import { arrearsFrom, closedSeatPeriods, seatPeriodAt, type SeatPeriod } from "@/lib/seat-rule";
import {
  prepareSeatBilling,
  recordSeatPeriod,
  resolveSeatPlan,
  type SeatPlan,
} from "@/lib/seat-sync.server";
import {
  chargeSeatPeriods,
  type SeatChargeContext,
  type SeatChargeOutcome,
} from "@/lib/seat-charges.server";

/** How far back a run looks for a closed period nobody charged. Two months:
 *  enough to catch a missed renewal and a missed sweep, short enough that a
 *  subscription's whole history is never re-examined every night. */
export const LOOKBACK_SECONDS = 70 * 24 * 60 * 60;
/** The nightly sweep leaves a period alone for this long after it closes, so
 *  the renewal webhook puts it on the renewal invoice rather than the sweep
 *  putting it on one of its own. */
export const RENEWAL_GRACE_SECONDS = 2 * 60 * 60;
/** A bound, so a night with a backlog cannot turn into an incident. */
export const SWEEP_LIMIT = 200;

type OrgRow = {
  id: string;
  slug: string | null;
  is_comped: boolean | null;
  timezone: string | null;
  stripe_subscription_id?: string | null;
};

/** The earliest moment a seat period may start and still be charged. */
export function chargeFloor(args: {
  markedFrom: number | null;
  startDate?: number | null;
  trialEnd?: number | null;
  now: number;
}): number {
  // No marker means the subscription is still on the old rule and has not
  // been through the changeover: charge nothing.
  if (args.markedFrom === null) return Number.POSITIVE_INFINITY;
  return Math.max(
    args.markedFrom,
    args.startDate ?? 0,
    // Seats used during a free trial are not charged.
    args.trialEnd ?? 0,
    args.now - LOOKBACK_SECONDS,
  );
}

type Loaded = { ctx: SeatChargeContext; plan: SeatPlan } | { skipped: string };

async function load(stripe: Stripe, admin: unknown, sub: Stripe.Subscription): Promise<Loaded> {
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  const { data } = await (admin as OrgsDb)
    .from("organizations")
    .select("id, slug, is_comped, timezone")
    .eq("stripe_customer_id", customer)
    .maybeSingle();
  const org = data as OrgRow | null;
  if (!org) return { skipped: "no_org" };
  if (isDemoOrganization(org)) return { skipped: "demo_org" };
  const plan = await resolveSeatPlan(stripe, sub, admin);
  if (!plan) return { skipped: "not_per_employee_plan" };
  if (typeof sub.billing_cycle_anchor !== "number") return { skipped: "no_anchor" };
  return { ctx: { stripe, admin, orgId: org.id, sub, plan, timeZone: org.timezone }, plan };
}

type OrgsDb = {
  from: (t: "organizations") => {
    select: (c: string) => {
      eq: (k: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown }> };
    };
  };
};

async function stripeOrNull(): Promise<Stripe | null> {
  const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  return secret ? makeStripe(secret) : null;
}

async function admin(): Promise<unknown> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/** The subscription a draft invoice belongs to, on either API shape. */
export function invoiceSubscriptionId(inv: unknown): string | null {
  const i = inv as {
    subscription?: string | { id: string } | null;
    parent?: {
      subscription_details?: { subscription?: string | { id: string } | null } | null;
    } | null;
  };
  const s = i.parent?.subscription_details?.subscription ?? i.subscription ?? null;
  if (!s) return null;
  return typeof s === "string" ? s : s.id;
}

/**
 * The latest moment an in-advance seat line on this invoice paid through, or
 * null. A renewal drafted while the old licensed seat item was still on the
 * subscription has charged the NEW period's seats in advance; that period is
 * then prepaid too.
 */
export function prepaidThroughOnInvoice(inv: unknown, seatPriceIds: Set<string>): number | null {
  const lines =
    (
      inv as {
        lines?: {
          data?: Array<{
            quantity?: number | null;
            period?: { end?: number | null } | null;
            price?: { id?: string } | string | null;
            pricing?: { price_details?: { price?: string | { id: string } | null } | null } | null;
          }>;
        };
      }
    ).lines?.data ?? [];
  let through: number | null = null;
  for (const l of lines) {
    const raw = l.pricing?.price_details?.price ?? l.price ?? null;
    const id = !raw ? null : typeof raw === "string" ? raw : (raw.id ?? null);
    if (!id || !seatPriceIds.has(id) || !((l.quantity ?? 0) > 0)) continue;
    const end = l.period?.end;
    if (typeof end === "number" && (through === null || end > through)) through = end;
  }
  return through;
}

export type RenewalSummary = { skipped: string } | { charged: SeatChargeOutcome[] };

/**
 * invoice.created. On a subscription's renewal, while the invoice is still a
 * draft, put the seat periods that have just closed on it.
 */
export async function chargeSeatsOnRenewalInvoice(inv: Stripe.Invoice): Promise<RenewalSummary> {
  if (inv.billing_reason !== "subscription_cycle") return { skipped: "not_a_renewal" };
  if (inv.status !== "draft" || !inv.id) return { skipped: "not_a_draft" };
  const subId = invoiceSubscriptionId(inv);
  if (!subId) return { skipped: "no_subscription" };
  const stripe = await stripeOrNull();
  if (!stripe) return { skipped: "stripe_not_configured" };
  const db = await admin();

  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
  const loaded = await load(stripe, db, sub);
  if ("skipped" in loaded) return loaded;
  const { ctx, plan } = loaded;

  const prep = await prepareSeatBilling(stripe, sub, plan, {
    prepaidThrough: prepaidThroughOnInvoice(inv, plan.seatPriceIds),
  });
  const now = Math.floor(Date.now() / 1000);
  const anchor = sub.billing_cycle_anchor;
  const periods = closedSeatPeriods({
    anchor,
    from: chargeFloor({
      markedFrom: prep.markedFrom,
      startDate: sub.start_date,
      trialEnd: sub.trial_end,
      now,
    }),
    until: now,
  });
  const charged = await chargeSeatPeriods(ctx, periods, () => "renewal", {
    kind: "renewal_invoice",
    invoiceId: inv.id,
  });
  await recordSeatPeriod(db, ctx.orgId, seatPeriodAt(anchor, now));
  return { charged };
}

/**
 * customer.subscription.deleted. The final period has no renewal invoice to
 * ride on, so it is charged on one of its own: from its start to the moment
 * the subscription ended, exactly once (owner, 2026-10-09).
 */
export async function chargeFinalSeatPeriods(ended: Stripe.Subscription): Promise<RenewalSummary> {
  const stripe = await stripeOrNull();
  if (!stripe) return { skipped: "stripe_not_configured" };
  const db = await admin();

  let sub = ended;
  try {
    sub = await stripe.subscriptions.retrieve(ended.id, { expand: ["items.data.price"] });
  } catch {
    /* the event's own snapshot will do */
  }
  const loaded = await load(stripe, db, sub);
  if ("skipped" in loaded) return loaded;

  const now = Math.floor(Date.now() / 1000);
  const endedAt = sub.ended_at ?? sub.canceled_at ?? now;
  // No changeover on a dead subscription: Stripe will not update it, and an
  // unmarked one was still on the old rule, which prepaid the period it ended
  // in. Charging that period again would charge it twice.
  const marked = arrearsFrom((sub.metadata ?? {}) as Record<string, string>);
  const periods = closedSeatPeriods({
    anchor: sub.billing_cycle_anchor,
    from: chargeFloor({
      markedFrom: marked,
      startDate: sub.start_date,
      trialEnd: sub.trial_end,
      now: endedAt,
    }),
    until: endedAt,
    endedAt,
  });
  const last = periods.length - 1;
  const charged = await chargeSeatPeriods(
    loaded.ctx,
    periods,
    (_p, i) => (i === last ? "cancellation" : "period_close"),
    { kind: "own_invoice" },
  );
  return { charged };
}

export type SweepSummary = {
  considered: number;
  billed: number;
  nothing_to_bill: number;
  failed: number;
  skipped_reasons: Record<string, number>;
};

/** Which orgs tonight's sweep should look at: a seat period has closed since
 *  the last look (past the renewal grace), or nobody has looked yet. Pure. */
export function dueForSeatSweep(
  rows: Array<OrgRow & { seat_period_end: string | null }>,
  now: Date,
): OrgRow[] {
  const cutoff = now.getTime() - RENEWAL_GRACE_SECONDS * 1000;
  return rows.filter((o) => {
    if (isDemoOrganization(o)) return false;
    if (!o.seat_period_end) return true;
    const end = Date.parse(o.seat_period_end);
    return !Number.isFinite(end) || end <= cutoff;
  });
}

/** One org, nightly: changeover, then every closed period not yet charged. */
async function sweepOne(
  stripe: Stripe,
  db: unknown,
  subId: string,
  now: number,
): Promise<SeatChargeOutcome[] | { skipped: string }> {
  const sub = await stripe.subscriptions.retrieve(subId, { expand: ["items.data.price"] });
  if (
    sub.status === "canceled" ||
    sub.status === "incomplete_expired" ||
    sub.status === "incomplete"
  ) {
    return { skipped: `status_${sub.status}` };
  }
  const loaded = await load(stripe, db, sub);
  if ("skipped" in loaded) return loaded;
  const prep = await prepareSeatBilling(stripe, sub, loaded.plan);
  const anchor = sub.billing_cycle_anchor;
  const periods = closedSeatPeriods({
    anchor,
    from: chargeFloor({
      markedFrom: prep.markedFrom,
      startDate: sub.start_date,
      trialEnd: sub.trial_end,
      now,
    }),
    until: now - RENEWAL_GRACE_SECONDS,
  });
  const charged = await chargeSeatPeriods(loaded.ctx, periods, () => "period_close", {
    kind: "own_invoice",
  });
  await recordSeatPeriod(db, loaded.ctx.orgId, seatPeriodAt(anchor, now));
  return charged;
}

export async function sweepSeatCharges(nowDate: Date = new Date()): Promise<SweepSummary> {
  const summary: SweepSummary = {
    considered: 0,
    billed: 0,
    nothing_to_bill: 0,
    failed: 0,
    skipped_reasons: {},
  };
  const stripe = await stripeOrNull();
  if (!stripe) {
    summary.skipped_reasons.stripe_not_configured = 1;
    return summary;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("organizations")
    .select("id, slug, is_comped, timezone, stripe_subscription_id")
    .not("stripe_subscription_id", "is", null)
    .is("deleted_at", null)
    .limit(5_000);
  if (error) throw new Error(error.message);
  const orgs = (data ?? []) as OrgRow[];

  const { data: periods } = await (supabaseAdmin as unknown as PeriodsDb)
    .from("org_seat_periods")
    .select("organization_id, period_end");
  const endByOrg = new Map(
    ((periods ?? []) as Array<{ organization_id: string; period_end: string }>).map((p) => [
      p.organization_id,
      p.period_end,
    ]),
  );

  const due = dueForSeatSweep(
    orgs.map((o) => ({ ...o, seat_period_end: endByOrg.get(o.id) ?? null })),
    nowDate,
  );
  if (due.length > SWEEP_LIMIT) {
    console.warn(`[nightly] ${due.length} orgs due a seat sweep; doing ${SWEEP_LIMIT}`);
  }
  const now = Math.floor(nowDate.getTime() / 1000);
  await retryUnfinishedCharges(stripe, supabaseAdmin, summary);
  for (const org of due.slice(0, SWEEP_LIMIT)) {
    summary.considered++;
    const subId = org.stripe_subscription_id;
    if (!subId || !/^sub_[A-Za-z0-9]{6,}/.test(subId) || subId.includes("demo")) {
      summary.skipped_reasons.no_subscription = (summary.skipped_reasons.no_subscription ?? 0) + 1;
      continue;
    }
    try {
      const r = await sweepOne(stripe, supabaseAdmin, subId, now);
      if ("skipped" in r) {
        summary.skipped_reasons[r.skipped] = (summary.skipped_reasons[r.skipped] ?? 0) + 1;
        continue;
      }
      for (const o of r) {
        if (o.status === "billed") summary.billed++;
        else if (o.status === "nothing_to_bill") summary.nothing_to_bill++;
        else if (o.status === "failed") summary.failed++;
      }
    } catch (e) {
      summary.failed++;
      console.error("[nightly] seat sweep failed", org.id, (e as Error).message);
    }
  }
  return summary;
}

/**
 * Periods a run claimed and did not finish: Stripe refused, or the run died.
 * Retried by subscription, live or not -- a cancelled subscription's final
 * period is only ever charged from here if the webhook's attempt failed.
 * claim_seat_charge decides what may be retried (see the migration).
 */
async function retryUnfinishedCharges(
  stripe: Stripe,
  db: unknown,
  summary: SweepSummary,
): Promise<void> {
  // A claim older than 23 hours is past Stripe's idempotency window and is
  // left for a person (claim_seat_charge refuses it); five attempts is enough
  // to tell a real fault from a hiccup.
  const stale = new Date(Date.now() - 23 * 60 * 60_000).toISOString();
  const { data } = await (db as RetryDb)
    .from("seat_charges")
    .select("stripe_subscription_id, period_start, period_end, reason")
    .or(`status.eq.failed,and(status.eq.claimed,claimed_at.gt.${stale})`)
    .lt("attempts", 5)
    .limit(50);
  const { chargeSeatPeriod } = await import("@/lib/seat-charges.server");
  for (const row of (data ?? []) as Array<{
    stripe_subscription_id: string;
    period_start: string;
    period_end: string;
    reason: "renewal" | "period_close" | "cancellation";
  }>) {
    try {
      const sub = await stripe.subscriptions.retrieve(row.stripe_subscription_id, {
        expand: ["items.data.price"],
      });
      const loaded = await load(stripe, db, sub);
      if ("skipped" in loaded) continue;
      const period = {
        start: Math.floor(Date.parse(row.period_start) / 1000),
        end: Math.floor(Date.parse(row.period_end) / 1000),
      };
      const o = await chargeSeatPeriod(loaded.ctx, period, row.reason, { kind: "own_invoice" });
      if (o.status === "billed") summary.billed++;
      else if (o.status === "nothing_to_bill") summary.nothing_to_bill++;
      else if (o.status === "failed") summary.failed++;
    } catch (e) {
      summary.failed++;
      console.error(
        "[nightly] seat charge retry failed",
        row.stripe_subscription_id,
        (e as Error).message,
      );
    }
  }
}

type RetryDb = {
  from: (t: "seat_charges") => {
    select: (c: string) => {
      or: (f: string) => {
        lt: (
          k: string,
          v: number,
        ) => { limit: (n: number) => PromiseLike<{ data: unknown[] | null }> };
      };
    };
  };
};

type PeriodsDb = {
  from: (t: "org_seat_periods") => {
    select: (c: string) => PromiseLike<{ data: unknown[] | null }>;
  };
};

export type { SeatPeriod };
