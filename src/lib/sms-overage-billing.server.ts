// #988 — a closed month's texting overage becomes one Stripe invoice item on
// the org's next invoice. Same three guards as ai-overage-billing.server.ts,
// and for the same reasons (read its header): only closed months; the claim on
// `sms_usage_periods.billed_at` is taken in the database BEFORE Stripe is
// called; and the Stripe call carries idempotency key
// `sms-overage-<org>-<YYYY-MM>`, so a retry reaches the same invoice item.
//
// $10 per started block of 500 segments past the 1,000 included. The terms
// are read from the managed-sms catalog row, not hard-coded, by
// `claim_sms_overage`, which also recounts the month from the ledger.
//
// OFF until TEXTING_USAGE_BILLING_LIVE (lib/texting-launch) is turned on.

import { orgLocalDay, DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { makeStripe } from "@/lib/stripe-client.server";
import { MANAGED_TEXTING_SLUG } from "@/lib/managed-texting";
import { TEXTING_USAGE_BILLING_LIVE } from "@/lib/texting-launch";

export type SmsOverageOutcome =
  | {
      billed: true;
      orgId: string;
      periodMonth: string;
      cents: number;
      blocks: number;
      invoiceItemId: string;
    }
  | { skipped: string; orgId: string; periodMonth?: string };

type PeriodRow = { organization_id: string; period_month: string; segments?: number };

/** What `claim_sms_overage` hands back. The segment count is RECOUNTED from
 *  sms_usage_events inside the claim, under the same per-org, per-month lock
 *  the rollup trigger takes, so it is never a rollup that lost a concurrent
 *  send (#1032 review, M3). */
type Claim = {
  outcome: "claimed" | "no_overage" | "already_billed" | "no_stripe_customer" | "not_metered";
  segments: number;
  blocks: number;
  cents: number;
  segments_included: number | null;
  block_size: number | null;
};

function currentOrgMonth(tz: string, now: Date = new Date()): string {
  return `${orgLocalDay(now, tz).slice(0, 7)}-01`;
}

function nextMonth(periodMonth: string): string {
  const d = new Date(`${periodMonth.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  return d.toISOString().slice(0, 10);
}

/** Did the org hold the managed-sms add-on, PAID, for the billed month? An
 *  active row with a Stripe subscription item, started before the month
 *  ended, not cancelled and not waived. A comped holder (no Stripe item), a
 *  waived one and a cancelled one get no overage item (#1032 review, S3).
 *  `null` when it could not be read: the month is then left for tomorrow
 *  rather than closed on a read that failed. */
async function heldManagedTextingFor(orgId: string, periodMonth: string): Promise<boolean | null> {
  const db = supabaseAdmin as any;
  const { data: addon, error: addonErr } = await db
    .from("platform_addons")
    .select("id")
    .eq("slug", MANAGED_TEXTING_SLUG)
    .maybeSingle();
  if (addonErr) return null;
  if (!addon?.id) return false;
  const { data: rows, error } = await db
    .from("org_platform_addons")
    .select("status, canceled_at, waived_reason, stripe_subscription_item_id, created_at")
    .eq("organization_id", orgId)
    .eq("addon_id", addon.id);
  if (error) return null;
  const monthEnd = nextMonth(periodMonth);
  return ((rows ?? []) as Array<Record<string, unknown>>).some(
    (r) =>
      r.status === "active" &&
      r.canceled_at == null &&
      r.waived_reason == null &&
      Boolean(r.stripe_subscription_item_id) &&
      (r.created_at == null || String(r.created_at).slice(0, 10) < monthEnd),
  );
}

/** Close a month with nothing billed. Only ever a month that is not billable
 *  at all; the price is never decided here. */
async function closeUnbilled(orgId: string, periodMonth: string): Promise<void> {
  await (supabaseAdmin as any)
    .from("sms_usage_periods")
    .update({ billed_at: new Date().toISOString(), billed_blocks: 0, billed_cents: 0 })
    .eq("organization_id", orgId)
    .eq("period_month", periodMonth)
    .is("billed_at", null)
    .select("organization_id");
}

/** Bill one closed month for one org. Never throws. Bills nothing, claims
 *  nothing and marks nothing while TEXTING_USAGE_BILLING_LIVE is off. */
export async function billOrgSmsOverage(
  row: PeriodRow,
  opts: { live?: boolean } = {},
): Promise<SmsOverageOutcome> {
  const orgId = row.organization_id;
  const periodMonth = row.period_month;
  if (!(opts.live ?? TEXTING_USAGE_BILLING_LIVE))
    return { skipped: "billing_off", orgId, periodMonth };
  const db = supabaseAdmin as any;

  const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) return { skipped: "stripe_not_configured", orgId, periodMonth };

  const held = await heldManagedTextingFor(orgId, periodMonth);
  if (held === null) return { skipped: "addon_unreadable", orgId, periodMonth };
  if (!held) {
    await closeUnbilled(orgId, periodMonth);
    return { skipped: "not_a_paying_managed_sms_holder", orgId, periodMonth };
  }

  const { data: org } = await db
    .from("organizations")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", orgId)
    .maybeSingle();

  // GUARD 2 — recount and claim before charging, in one database call. A
  // month with nothing over the allowance is closed by the same call; one
  // with an overage but no Stripe customer is left unclaimed.
  // rpc-role: service
  const { data, error } = await db.rpc("claim_sms_overage", {
    _org_id: orgId,
    _period_month: periodMonth,
    _can_charge: Boolean(org?.stripe_customer_id),
  });
  if (error) {
    console.error("[sms-overage] claim failed", orgId, periodMonth, error);
    return { skipped: `claim_error: ${error.message ?? String(error)}`, orgId, periodMonth };
  }
  const claim = (Array.isArray(data) ? data[0] : data) as Claim | undefined;
  if (!claim) return { skipped: "claim_empty", orgId, periodMonth };
  if (claim.outcome === "not_metered")
    return { skipped: "texting_not_metered", orgId, periodMonth };
  if (claim.outcome !== "claimed") return { skipped: claim.outcome, orgId, periodMonth };

  const segments = Number(claim.segments);
  const blocks = Number(claim.blocks);
  const cents = Number(claim.cents);
  const included = Number(claim.segments_included);
  const blockSize = Number(claim.block_size);

  const stripe = await makeStripe(secret);
  const monthLabel = new Date(`${periodMonth}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  try {
    const item = await stripe.invoiceItems.create(
      {
        customer: org.stripe_customer_id,
        ...(org.stripe_subscription_id ? { subscription: org.stripe_subscription_id } : {}),
        amount: cents,
        currency: "usd",
        // TODO(#988): this wording awaits Brendan's OK with the texting terms.
        // It says "texts" where the count is segments, so a 1,000-text month
        // can bill. Not finalized here on purpose; do not change it without
        // that OK.
        description:
          `Texting for ${monthLabel}: ${segments.toLocaleString()} texts used, ` +
          `${included.toLocaleString()} included, ${blocks} extra block${blocks === 1 ? "" : "s"} ` +
          `of ${blockSize.toLocaleString()}`,
        metadata: {
          kind: "sms_overage",
          organization_id: orgId,
          period_month: periodMonth,
          segments_used: String(segments),
          segments_included: String(included),
          blocks: String(blocks),
        },
      },
      // GUARD 3.
      { idempotencyKey: `sms-overage-${orgId}-${periodMonth.slice(0, 7)}` },
    );
    await db
      .from("sms_usage_periods")
      .update({ stripe_invoice_item_id: item.id })
      .eq("organization_id", orgId)
      .eq("period_month", periodMonth)
      .is("stripe_invoice_item_id", null)
      .select("organization_id");
    return { billed: true, orgId, periodMonth, cents, blocks, invoiceItemId: item.id };
  } catch (e) {
    console.error("[sms-overage] stripe invoice item failed", orgId, periodMonth, e);
    return { skipped: `stripe_error: ${(e as Error).message}`, orgId, periodMonth };
  }
}

/** Bill every closed, unbilled month. Safe to run nightly. While
 *  TEXTING_USAGE_BILLING_LIVE is off (lib/texting-launch) it reads nothing,
 *  claims nothing and creates no invoice item: `live: false` in the result. */
export async function runSmsOverageBilling(opts: { live?: boolean } = {}): Promise<{
  live: boolean;
  billed: number;
  centsTotal: number;
  skipped: number;
  outcomes: SmsOverageOutcome[];
}> {
  const live = opts.live ?? TEXTING_USAGE_BILLING_LIVE;
  if (!live) return { live: false, billed: 0, centsTotal: 0, skipped: 0, outcomes: [] };
  const db = supabaseAdmin as any;
  const { data: rows } = await db
    .from("sms_usage_periods")
    .select("organization_id, period_month")
    .is("billed_at", null);

  const outcomes: SmsOverageOutcome[] = [];
  let billed = 0;
  let centsTotal = 0;
  for (const raw of (rows ?? []) as PeriodRow[]) {
    // GUARD 1 — the org's own current month is still accruing.
    const { data: org } = await db
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
    const o = await billOrgSmsOverage(raw, { live });
    outcomes.push(o);
    if ("billed" in o) {
      billed++;
      centsTotal += o.cents;
    }
  }
  return { live: true, billed, centsTotal, skipped: outcomes.length - billed, outcomes };
}
