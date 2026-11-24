// #988 — a closed month's texting overage becomes one Stripe invoice item on
// the org's next invoice. Same three guards as ai-overage-billing.server.ts,
// and for the same reasons (read its header): only closed months; the claim on
// `sms_usage_periods.billed_at` is taken in the database BEFORE Stripe is
// called; and the Stripe call carries idempotency key
// `sms-overage-<org>-<YYYY-MM>`, so a retry reaches the same invoice item.
//
// $10 per started block of 500 segments past the 1,000 included. The terms
// are read from the managed-sms catalog row, not hard-coded.

import { orgLocalDay, DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { makeStripe } from "@/lib/stripe-client.server";
import { DEFAULT_TEXTING_TERMS, overageBlocks, type TextingTerms } from "@/lib/sms-segments";

export type SmsOverageOutcome =
  | { billed: true; orgId: string; periodMonth: string; cents: number; blocks: number; invoiceItemId: string }
  | { skipped: string; orgId: string; periodMonth?: string };

type PeriodRow = { organization_id: string; period_month: string; segments: number };

function currentOrgMonth(tz: string, now: Date = new Date()): string {
  return `${orgLocalDay(now, tz).slice(0, 7)}-01`;
}

async function readTerms(): Promise<TextingTerms | null> {
  const { data } = await (supabaseAdmin as any)
    .from("platform_addons")
    .select("texting_segments_included, texting_block_size, texting_block_cents, texting_ceiling_blocks")
    .eq("slug", "managed-sms")
    .maybeSingle();
  if (!data || data.texting_segments_included == null) return null;
  return {
    included: Number(data.texting_segments_included),
    blockSize: Number(data.texting_block_size ?? DEFAULT_TEXTING_TERMS.blockSize),
    blockCents: Number(data.texting_block_cents ?? DEFAULT_TEXTING_TERMS.blockCents),
    ceilingBlocks: Number(data.texting_ceiling_blocks ?? DEFAULT_TEXTING_TERMS.ceilingBlocks),
  };
}

/** Bill one closed month for one org. Never throws. */
export async function billOrgSmsOverage(row: PeriodRow): Promise<SmsOverageOutcome> {
  const orgId = row.organization_id;
  const periodMonth = row.period_month;
  const db = supabaseAdmin as any;

  const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
  if (!secret) return { skipped: "stripe_not_configured", orgId, periodMonth };

  const terms = await readTerms();
  if (!terms) return { skipped: "texting_not_metered", orgId, periodMonth };

  const blocks = overageBlocks(row.segments ?? 0, terms);
  const cents = blocks * terms.blockCents;

  if (cents <= 0) {
    await db
      .from("sms_usage_periods")
      .update({ billed_at: new Date().toISOString(), billed_blocks: 0, billed_cents: 0 })
      .eq("organization_id", orgId)
      .eq("period_month", periodMonth)
      .is("billed_at", null)
      .select("organization_id");
    return { skipped: "no_overage", orgId, periodMonth };
  }

  const { data: org } = await db
    .from("organizations")
    .select("stripe_customer_id, stripe_subscription_id")
    .eq("id", orgId)
    .maybeSingle();
  if (!org?.stripe_customer_id) return { skipped: "no_stripe_customer", orgId, periodMonth };

  // GUARD 2 — claim before charging.
  const { data: claimed } = await db
    .from("sms_usage_periods")
    .update({ billed_at: new Date().toISOString(), billed_blocks: blocks, billed_cents: cents })
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
        customer: org.stripe_customer_id,
        ...(org.stripe_subscription_id ? { subscription: org.stripe_subscription_id } : {}),
        amount: cents,
        currency: "usd",
        description:
          `Texting for ${monthLabel}: ${(row.segments ?? 0).toLocaleString()} texts used, ` +
          `${terms.included.toLocaleString()} included, ${blocks} extra block${blocks === 1 ? "" : "s"} ` +
          `of ${terms.blockSize.toLocaleString()}`,
        metadata: {
          kind: "sms_overage",
          organization_id: orgId,
          period_month: periodMonth,
          segments_used: String(row.segments ?? 0),
          segments_included: String(terms.included),
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

/** Bill every closed, unbilled month. Safe to run nightly. */
export async function runSmsOverageBilling(): Promise<{
  billed: number;
  centsTotal: number;
  skipped: number;
  outcomes: SmsOverageOutcome[];
}> {
  const db = supabaseAdmin as any;
  const { data: rows } = await db
    .from("sms_usage_periods")
    .select("organization_id, period_month, segments")
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
      outcomes.push({ skipped: "month_still_open", orgId: raw.organization_id, periodMonth: raw.period_month });
      continue;
    }
    const o = await billOrgSmsOverage(raw);
    outcomes.push(o);
    if ("billed" in o) {
      billed++;
      centsTotal += o.cents;
    }
  }
  return { billed, centsTotal, skipped: outcomes.length - billed, outcomes };
}
