// Late-change fees on portal reschedules and cancels (#730, decision D6).
//
// What decides whether money moves, in order. Every one must say yes:
//
//   1. The change was APPLIED (instantly, or approved by the owner) and the
//      server computed a fee for it. A pending, denied or withdrawn request
//      never reaches here: begin_portal_change_fee refuses it.
//   2. The owner turned on organizations.portal_change_fees_autocharge
//      (default OFF, owner-only in the database).
//   3. The SERVER is configured to charge, and only in Stripe TEST mode:
//      PORTAL_CHANGE_FEES_CHARGING=test, and the Connect secret is a test key.
//      There is no live setting in this file. Allowing live charges is a
//      separate, deliberate change for the owner to ask for.
//   4. The customer has a saved card on the business's connected account.
//
// A "no" at 2, 3 or 4 records the fee as not_charged with the reason, and
// logs it, so the office can see it and collect another way. Nothing here
// ever throws into the customer's or the owner's request: the change has
// already been applied by the time a fee is attempted.
//
// Stripe practice followed:
//   * A StripeClient instance per call (connectStripe -> makeStripe), never a
//     global key, pinned to STRIPE_API_VERSION.
//   * The charge is made on the business's connected account, the same funnel
//     every other customer charge uses (requireOrgStripeAccount).
//   * One idempotency key per fee, stored on the row before the call:
//     "portal-change-fee:<request id>". A retry, a double-tap or two servers
//     racing all reach the same PaymentIntent.
//   * The amount is the row's, which the database copied from the request,
//     which the database computed. Nothing from the browser.
//   * No payment_method_types: automatic payment methods, without redirects,
//     because an off-session charge has nobody to redirect.
//   * The webhook is the only thing that marks a fee succeeded or failed
//     (record_portal_change_fee_event, deduplicated by event id and matched to
//     the connected account the event came from).

import type { Stripe } from "stripe";

/** The PaymentIntent metadata `source` the Connect webhook routes on. */
export const PORTAL_CHANGE_FEE_SOURCE = "portal_change_fee";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FeeChargingMode = { enabled: true } | { enabled: false; reason: string };

/**
 * Whether this server may charge a fee at all. Test mode only, on purpose.
 * Pure, so the test can pin every branch.
 */
export function feeChargingMode(env: {
  PORTAL_CHANGE_FEES_CHARGING?: string;
  STRIPE_CONNECT_SECRET_KEY?: string;
}): FeeChargingMode {
  if (env.PORTAL_CHANGE_FEES_CHARGING !== "test") {
    return { enabled: false, reason: "Automatic fee charging is not enabled on this server." };
  }
  const key = env.STRIPE_CONNECT_SECRET_KEY ?? "";
  if (!key.startsWith("sk_test_") && !key.startsWith("rk_test_")) {
    return {
      enabled: false,
      reason: "Fee charging runs in Stripe test mode only, and this server has no test key.",
    };
  }
  return { enabled: true };
}

type Charge = {
  id: string;
  organization_id: string;
  client_id: string;
  request_id: string;
  amount_cents: number;
  currency: string;
  status: string;
  idempotency_key: string;
};

type Db = {
  rpc: (fn: string, args: Record<string, unknown>) => any;
  from: (t: string) => any;
};

type Deps = {
  db?: Db;
  env?: Record<string, string | undefined>;
  stripe?: () => Promise<{
    stripe: Pick<Stripe, "paymentIntents" | "customers">;
    stripeAccount: string;
  }>;
};

async function note(
  db: Db,
  charge: Charge,
  status: "not_charged" | "processing" | "requires_action" | "failed",
  extra: {
    paymentIntentId?: string | null;
    account?: string | null;
    reason?: string | null;
    livemode?: boolean | null;
  } = {},
) {
  // rpc-role: service (service-role client only; EXECUTE is granted to service_role, not authenticated)
  const { error } = await db.rpc("note_portal_change_fee_attempt", {
    _charge_id: charge.id,
    _status: status,
    _payment_intent_id: extra.paymentIntentId ?? null,
    _account: extra.account ?? null,
    _reason: extra.reason ?? null,
    _livemode: extra.livemode ?? null,
  });
  if (error) console.error("portal change fee: could not record attempt", charge.id, error.message);
}

export type FeeOutcome =
  | { outcome: "none" }
  | { outcome: "already_attempted"; status: string }
  | { outcome: "not_charged"; reason: string }
  | { outcome: "submitted"; status: string; paymentIntentId: string }
  | { outcome: "failed"; reason: string };

/**
 * Attempt the fee for an applied or approved request. Safe to call more than
 * once: the second call finds the row already attempted and does nothing.
 */
export async function chargePortalChangeFee(
  requestId: string,
  deps: Deps = {},
): Promise<FeeOutcome> {
  const db: Db =
    deps.db ?? ((await import("@/integrations/supabase/client.server")).supabaseAdmin as any);
  const env = deps.env ?? process.env;

  // rpc-role: service (service-role client only; EXECUTE is granted to service_role, not authenticated)
  const { data: begun, error } = await db.rpc("begin_portal_change_fee", {
    _request_id: requestId,
  });
  if (error) {
    console.error("portal change fee: could not begin", requestId, error.message);
    return { outcome: "failed", reason: error.message };
  }
  const charge = (begun as { charge: Charge | null } | null)?.charge ?? null;
  if (!charge) return { outcome: "none" };
  if (charge.status !== "pending") return { outcome: "already_attempted", status: charge.status };

  const { data: org } = await db
    .from("organizations")
    .select("portal_change_fees_autocharge")
    .eq("id", charge.organization_id)
    .maybeSingle();
  if (!org?.portal_change_fees_autocharge) {
    const reason = "Automatic charging is off for this business. Collect this fee another way.";
    await note(db, charge, "not_charged", { reason });
    return { outcome: "not_charged", reason };
  }

  const mode = feeChargingMode(env);
  if (!mode.enabled) {
    await note(db, charge, "not_charged", { reason: mode.reason });
    return { outcome: "not_charged", reason: mode.reason };
  }

  const { data: client } = await db
    .from("clients")
    .select("id, stripe_customer_id, default_payment_method_id")
    .eq("id", charge.client_id)
    .eq("organization_id", charge.organization_id)
    .maybeSingle();
  if (!client?.stripe_customer_id || !client.default_payment_method_id) {
    const reason = "The client has no saved card.";
    await note(db, charge, "not_charged", { reason });
    return { outcome: "not_charged", reason };
  }

  let stripeAccount: string | null = null;
  try {
    const conn = deps.stripe
      ? await deps.stripe()
      : await (async () => {
          const { requireOrgStripeAccount, connectStripe } =
            await import("@/lib/stripe-connect.server");
          const acct = await requireOrgStripeAccount(charge.organization_id, {
            audience: "customer",
          });
          return { stripe: (await connectStripe()) as any, stripeAccount: acct.accountId };
        })();
    stripeAccount = conn.stripeAccount;

    if (!deps.stripe) {
      const { verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
      if (!(await verifyClientStripeCustomer(conn.stripe as any, stripeAccount, client))) {
        const reason = "The client's saved card is no longer on file.";
        await note(db, charge, "not_charged", { reason, account: stripeAccount });
        return { outcome: "not_charged", reason };
      }
    }

    // Durable correlation BEFORE Stripe is asked (#730 review, finding 2):
    // the row now names the account, and the intent will carry the row's id,
    // so a webhook that arrives before this function stores the intent's id
    // is still matched (record_portal_change_fee_event). If this fails,
    // nothing has been sent to Stripe.
    // rpc-role: service (service-role client only; EXECUTE is granted to service_role, not authenticated)
    const { error: prepErr } = await db.rpc("prepare_portal_change_fee", {
      _charge_id: charge.id,
      _account: stripeAccount,
    });
    if (prepErr) {
      console.error("portal change fee: could not prepare", charge.id, prepErr.message);
      return { outcome: "failed", reason: prepErr.message };
    }

    const pi = await conn.stripe.paymentIntents.create(
      {
        amount: charge.amount_cents,
        currency: charge.currency || "usd",
        customer: client.stripe_customer_id,
        payment_method: client.default_payment_method_id,
        automatic_payment_methods: { enabled: true, allow_redirects: "never" },
        off_session: true,
        confirm: true,
        description: "Late change fee",
        metadata: {
          source: PORTAL_CHANGE_FEE_SOURCE,
          fee_charge_id: charge.id,
          request_id: charge.request_id,
          organization_id: charge.organization_id,
        },
      },
      { idempotencyKey: charge.idempotency_key, stripeAccount },
    );
    const status = pi.status === "requires_action" ? "requires_action" : "processing";
    await note(db, charge, status, {
      paymentIntentId: pi.id,
      account: stripeAccount,
      livemode: pi.livemode,
    });
    return { outcome: "submitted", status, paymentIntentId: pi.id };
  } catch (e) {
    const err = e as { message?: string; raw?: { payment_intent?: { id?: string } } };
    const reason = err.message || "The card was not charged.";
    await note(db, charge, "failed", {
      reason,
      account: stripeAccount,
      // A declined off-session confirm still created an intent; keep its id
      // so the payment_failed webhook can find this row.
      paymentIntentId: err.raw?.payment_intent?.id ?? null,
    });
    return { outcome: "failed", reason };
  }
}

/**
 * The Connect webhook's half. `event.account` is the only trustworthy
 * identifier on a Connect event, so the database matches the fee by its
 * PaymentIntent AND that account; metadata is never trusted to name a row.
 * Returns what the database did: succeeded / failed / duplicate / unchanged /
 * unknown / ignored. Throws on a database error so Stripe retries; the route
 * answers 409 to "unknown" for the same reason (no fee matched yet).
 */
export async function recordPortalChangeFeeEvent(
  db: Db,
  event: Pick<Stripe.Event, "id" | "type" | "account" | "livemode"> & {
    data: {
      object: {
        id: string;
        last_payment_error?: { message?: string } | null;
        metadata?: Record<string, string> | null;
      };
    };
  },
): Promise<string> {
  if (event.type !== "payment_intent.succeeded" && event.type !== "payment_intent.payment_failed") {
    return "ignored";
  }
  const pi = event.data.object;
  // rpc-role: service (service-role client only; EXECUTE is granted to service_role, not authenticated)
  const { data, error } = await db.rpc("record_portal_change_fee_event", {
    _event_id: event.id,
    _event_type: event.type,
    _payment_intent_id: pi.id,
    _account: event.account ?? null,
    _succeeded: event.type === "payment_intent.succeeded",
    _message: pi.last_payment_error?.message ?? null,
    _livemode: event.livemode,
    // The fee row's own id, which the intent carries in its metadata. Used
    // only together with event.account, which the row was prepared for.
    _charge_id: UUID.test(pi.metadata?.fee_charge_id ?? "") ? pi.metadata!.fee_charge_id : null,
  });
  if (error) throw new Error(`portal change fee event ${event.id}: ${error.message}`);
  return String(data);
}
