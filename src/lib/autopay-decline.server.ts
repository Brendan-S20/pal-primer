// One decline counts once.
//
// `clients.autopay_failure_count` is the dunning ladder: at the org's
// `dunning_pause_after_failures` declines, autopay pauses and the office has to
// step in. Until 2026-10-07 two paths each added one to it in TypeScript, read
// then write: the Stripe webhook on EVERY delivery of
// payment_intent.payment_failed, and the nightly autopay run's catch block for
// the very charge whose failure that webhook was about to report. One decline
// could count two, three or four times, so autopay paused after as few as half
// the declines the business had set.
//
// Now the count has one owner, the SQL function `count_autopay_decline`
// (migration 20261007140000), which is idempotent per PaymentIntent: it
// remembers which PaymentIntents it has counted for the client, and a second
// report of one changes nothing. The pause is decided there too, from the
// same count.
//
// Who reports what:
//
//   * The webhook reports every saved-card decline, keyed on its
//     PaymentIntent. It is the authoritative signal: Stripe sends it for every
//     decline that reached Stripe, whoever started the charge, and keeps
//     redelivering until it is answered.
//   * The nightly run reports only a failure that NEVER PRODUCED a
//     PaymentIntent, with no key, because nothing else ever will: no
//     PaymentIntent, no webhook. See classifyNightlyAutopayFailure for exactly
//     which failures those are.

// The slice of the service-role client this uses. Callers pass the client
// itself (or the fake the tests drive) as a plain object: the generated types
// declare every RPC argument non-null, this one takes a NULL PaymentIntent by
// design, and matching the full generic client against a structural type is
// deeper than the compiler will go.
type Admin = {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
  from(table: string): {
    update(patch: Record<string, unknown>): {
      eq(column: string, value: string): PromiseLike<unknown>;
    };
  };
};

export type DeclineCount = {
  /** False when this PaymentIntent had already been counted. */
  counted: boolean;
  failureCount: number;
  paused: boolean;
  pauseAfter: number;
};

/**
 * Count one decline toward the client's dunning ladder, once per
 * PaymentIntent. `paymentIntentId` null means a failure that never reached
 * Stripe, which counts every time it is reported.
 *
 * Throws when the database refuses. The webhook lets that become a 500, so
 * Stripe redelivers the event later, which is safe precisely because the count
 * is idempotent.
 */
export async function countAutopayDecline(
  admin: object,
  args: { clientId: string; paymentIntentId: string | null; error: string | null },
): Promise<DeclineCount> {
  const { data, error } = await (admin as Admin).rpc("count_autopay_decline", {
    _client_id: args.clientId,
    _payment_intent_id: args.paymentIntentId,
    _error: args.error,
  });
  if (error) {
    const msg = (error as { message?: string }).message ?? String(error);
    throw new Error(`count_autopay_decline failed: ${msg}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { counted: boolean; failure_count: number; paused: boolean; pause_after: number }
    | null
    | undefined;
  if (!row) throw new Error("count_autopay_decline returned no row");
  return {
    counted: row.counted === true,
    failureCount: Number(row.failure_count ?? 0),
    paused: row.paused === true,
    pauseAfter: Number(row.pause_after ?? 0),
  };
}

/** The PaymentIntent a thrown Stripe error carries, if Stripe made one.
 *  `stripe.paymentIntents.create({ confirm: true })` that declines throws a
 *  StripeCardError whose `payment_intent` is the failed intent; Stripe sends
 *  payment_intent.payment_failed for that same intent. */
export function paymentIntentIdOf(e: unknown): string | null {
  const err = e as {
    payment_intent?: { id?: unknown } | string | null;
    raw?: { payment_intent?: { id?: unknown } | string | null };
  } | null;
  const pi = err?.payment_intent ?? err?.raw?.payment_intent ?? null;
  if (typeof pi === "string") return pi || null;
  return typeof pi?.id === "string" && pi.id ? pi.id : null;
}

/** Stripe error classes that are not a verdict on the card and may not even
 *  be a verdict from Stripe: the connection dropped, Stripe answered 5xx, or
 *  we were rate limited. The request may have reached Stripe (a dropped
 *  response to a charge that went through and declined), in which case the
 *  webhook reports the PaymentIntent; if it did not, tomorrow's run retries. */
const TRANSIENT = new Set(["StripeConnectionError", "StripeAPIError", "StripeRateLimitError"]);

export type NightlyFailure =
  /** The charge reached Stripe and has a PaymentIntent. The webhook counts it. */
  | "reported_by_webhook"
  /** Not a decline, and possibly not even an answer. Counted by nobody. */
  | "transient"
  /** Refused before Stripe made a PaymentIntent, or failed in our own code
   *  first (the fee quote, a refused request, a revoked key). No webhook will
   *  ever come, so the nightly run counts it. */
  | "never_reached_stripe";

export function classifyNightlyAutopayFailure(e: unknown): NightlyFailure {
  if (paymentIntentIdOf(e)) return "reported_by_webhook";
  const type = (e as { type?: unknown } | null)?.type;
  if (typeof type === "string" && TRANSIENT.has(type)) return "transient";
  return "never_reached_stripe";
}

/**
 * The nightly autopay run's catch block, for every failure except a vanished
 * customer (which clears the card instead). Records what went wrong for the
 * Billing tab on every failure, and counts toward the ladder only a failure
 * that never reached Stripe.
 */
export async function recordNightlyAutopayFailure(
  admin: object,
  args: { clientId: string; error: unknown },
): Promise<NightlyFailure> {
  const kind = classifyNightlyAutopayFailure(args.error);
  const msg = (args.error as Error | null)?.message || "autopay failed";
  if (kind === "never_reached_stripe") {
    await countAutopayDecline(admin, {
      clientId: args.clientId,
      paymentIntentId: null,
      error: msg,
    });
    return kind;
  }
  // Seen, not counted. The webhook counts a PaymentIntent; a transient failure
  // is nobody's decline. The attempt time is the one the retry ladder waits on.
  await (admin as Admin)
    .from("clients")
    .update({ autopay_last_attempt_at: new Date().toISOString(), autopay_last_error: msg })
    .eq("id", args.clientId);
  return kind;
}
