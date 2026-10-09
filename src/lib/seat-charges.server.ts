// Charging seats, one closed seat period at a time. What a seat is and why
// it is charged this way is in seat-rule.ts; read that first.
//
// Three ways a period gets here, and all three go through chargeSeatPeriod:
//
//   renewal       invoice.created on a monthly plan's renewal: the period that
//                 just closed goes onto the renewal invoice Stripe has just
//                 drafted, as its own line dated for that period.
//   period_close  the nightly sweep: a yearly plan's month that closed, or any
//                 period the webhook missed, on an invoice of its own.
//   cancellation  customer.subscription.deleted: the final period, from its
//                 start to the moment the subscription ended, on an invoice of
//                 its own.
//
// ── EXACTLY ONCE ──────────────────────────────────────────────────────────
//
// Every period is claimed in seat_charges (claim_seat_charge) BEFORE Stripe
// is called, keyed on (subscription, period start), so two of the paths above
// can never both charge it. Every invoice item carries `seat_charge_key` in
// its metadata, and a retried claim looks for that key in Stripe before
// creating anything, so a run that died between Stripe and the database is
// finished rather than repeated. Stripe idempotency keys cover the same
// window from Stripe's side.

import type Stripe from "stripe";
import { seatChargeLine, seatOverage, periodBoundaryIso, type SeatPeriod } from "@/lib/seat-rule";
import { billableSeatsBetween, type SeatPlan } from "@/lib/seat-sync.server";

export type SeatChargeReason = "renewal" | "period_close" | "cancellation";
export type SeatChargeTarget =
  { kind: "renewal_invoice"; invoiceId: string } | { kind: "own_invoice" };

export type SeatChargeOutcome =
  | {
      status: "billed";
      period: SeatPeriod;
      seats: number;
      amountCents: number;
      invoiceItemId: string;
      invoiceId: string | null;
    }
  | { status: "nothing_to_bill"; period: SeatPeriod; seen: number }
  | { status: "not_claimed"; period: SeatPeriod; why: string }
  | { status: "failed"; period: SeatPeriod; error: string };

export type SeatChargeContext = {
  stripe: Stripe;
  admin: unknown;
  orgId: string;
  sub: Stripe.Subscription;
  plan: SeatPlan;
  timeZone?: string | null;
};

type Claim = { claimed: boolean; id: string | null; status: string | null; retry: boolean };

type ChargesDb = {
  rpc: (
    fn: "claim_seat_charge",
    args: {
      _org_id: string;
      _subscription_id: string;
      _period_start: string;
      _period_end: string;
      _reason: SeatChargeReason;
    },
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  from: (t: "seat_charges") => {
    update: (row: Record<string, unknown>) => {
      eq: (k: "id", v: string) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

/** The key that names one subscription's one seat period, everywhere. */
export function seatChargeKey(subscriptionId: string, period: SeatPeriod): string {
  return `seat-charge:v1:${subscriptionId}:${period.start}`;
}

function customerOf(sub: Stripe.Subscription): string {
  return typeof sub.customer === "string" ? sub.customer : sub.customer.id;
}

function paymentMethodOf(sub: Stripe.Subscription): string | null {
  const pm = sub.default_payment_method;
  if (!pm) return null;
  return typeof pm === "string" ? pm : pm.id;
}

function invoiceIdOf(item: Stripe.InvoiceItem): string | null {
  const inv = item.invoice;
  if (!inv) return null;
  return typeof inv === "string" ? inv : (inv.id ?? null);
}

async function mark(admin: unknown, id: string | null, row: Record<string, unknown>) {
  if (!id) return;
  const { error } = await (admin as ChargesDb).from("seat_charges").update(row).eq("id", id);
  if (error) console.error("seat_charges update failed", id, error.message);
}

/** Was this period already put on an invoice by a run that died before
 *  recording it? Looks for the key in the customer's invoice items. */
async function findCharged(stripe: Stripe, customer: string, key: string) {
  const list = await stripe.invoiceItems.list({ customer, limit: 100 });
  return list.data.find((i) => i.metadata?.seat_charge_key === key) ?? null;
}

/**
 * Charge one closed seat period, once. Never throws: a failure is recorded on
 * the period (status `failed`) and the next run retries it.
 */
export async function chargeSeatPeriod(
  ctx: SeatChargeContext,
  period: SeatPeriod,
  reason: SeatChargeReason,
  target: SeatChargeTarget,
): Promise<SeatChargeOutcome> {
  const { stripe, admin, orgId, sub, plan } = ctx;

  let claim: Claim;
  try {
    const { data, error } = await (admin as ChargesDb).rpc("claim_seat_charge", {
      _org_id: orgId,
      _subscription_id: sub.id,
      _period_start: periodBoundaryIso(period.start),
      _period_end: periodBoundaryIso(period.end),
      _reason: reason,
    });
    if (error) throw new Error(error.message);
    claim = data as Claim;
  } catch (e) {
    return { status: "failed", period, error: `claim: ${(e as Error).message}` };
  }
  if (!claim?.claimed) {
    return { status: "not_claimed", period, why: claim?.status ?? "unknown" };
  }

  try {
    const seen = await billableSeatsBetween(admin, orgId, period.start, period.end);
    const seats = seatOverage(seen, plan.includedSeats);
    const counts = {
      seats_seen: seen,
      included_seats: plan.includedSeats,
      billed_seats: seats,
      unit_amount_cents: plan.unitAmountCents,
    };
    if (seats === 0 || plan.unitAmountCents <= 0) {
      await mark(admin, claim.id, {
        ...counts,
        amount_cents: 0,
        status: "nothing_to_bill",
        billed_at: new Date().toISOString(),
      });
      return { status: "nothing_to_bill", period, seen };
    }

    const line = seatChargeLine({
      period,
      seats,
      unitAmountCents: plan.unitAmountCents,
      timeZone: ctx.timeZone ?? "UTC",
    });
    const key = seatChargeKey(sub.id, period);
    const customer = customerOf(sub);
    const currency = sub.currency ?? "usd";

    const record = async (item: Stripe.InvoiceItem): Promise<SeatChargeOutcome> => {
      const invoiceId = invoiceIdOf(item);
      await mark(admin, claim.id, {
        ...counts,
        amount_cents: line.amountCents,
        currency,
        status: "billed",
        stripe_invoice_item_id: item.id,
        stripe_invoice_id: invoiceId,
        billed_at: new Date().toISOString(),
      });
      return {
        status: "billed",
        period,
        seats,
        amountCents: line.amountCents,
        invoiceItemId: item.id,
        invoiceId,
      };
    };

    if (claim.retry) {
      const already = await findCharged(stripe, customer, key);
      if (already) return record(already);
    }

    const item = {
      customer,
      currency,
      amount: line.amountCents,
      description: line.description,
      // The period it covers, so Stripe prints these dates on the line.
      period: { start: period.start, end: period.end },
      metadata: {
        kind: "seat_overage",
        seat_charge_key: key,
        organization_id: orgId,
        subscription: sub.id,
        seats: String(seats),
        seats_seen: String(seen),
        included_seats: String(plan.includedSeats),
      },
    } satisfies Stripe.InvoiceItemCreateParams;

    if (target.kind === "renewal_invoice") {
      try {
        const added = await stripe.invoiceItems.create(
          { ...item, invoice: target.invoiceId },
          { idempotencyKey: `${key}:renewal` },
        );
        return record(added);
      } catch (e) {
        // The draft finalized before we got to it, most likely. The period is
        // still ours to charge, on an invoice of its own.
        console.warn(
          "seat line could not go on the renewal invoice; invoicing it alone",
          (e as Error).message,
        );
      }
    }

    const pm = paymentMethodOf(sub);
    const invoice = await stripe.invoices.create(
      {
        customer,
        collection_method: "charge_automatically",
        auto_advance: true,
        // Only this line: nothing else pending on the customer rides along.
        pending_invoice_items_behavior: "exclude",
        ...(pm ? { default_payment_method: pm } : {}),
        description: line.description,
        metadata: { kind: "seat_overage", seat_charge_key: key, organization_id: orgId },
      },
      { idempotencyKey: `${key}:invoice` },
    );
    const added = await stripe.invoiceItems.create(
      { ...item, invoice: invoice.id },
      { idempotencyKey: `${key}:own` },
    );
    if (invoice.id) {
      await stripe.invoices.finalizeInvoice(invoice.id, { auto_advance: true });
    }
    return record(added);
  } catch (e) {
    const error = (e as Error).message.slice(0, 1000);
    await mark(admin, claim.id, { status: "failed", error });
    return { status: "failed", period, error };
  }
}

/** Charge each period in turn; one failure does not stop the rest. */
export async function chargeSeatPeriods(
  ctx: SeatChargeContext,
  periods: SeatPeriod[],
  reasonFor: (p: SeatPeriod, i: number) => SeatChargeReason,
  target: SeatChargeTarget,
): Promise<SeatChargeOutcome[]> {
  const out: SeatChargeOutcome[] = [];
  for (const [i, p] of periods.entries()) {
    out.push(await chargeSeatPeriod(ctx, p, reasonFor(p, i), target));
  }
  return out;
}
