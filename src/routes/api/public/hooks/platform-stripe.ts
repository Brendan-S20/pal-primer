import { createFileRoute } from "@tanstack/react-router";
import { makeStripe, warnOnApiVersionMismatch } from "@/lib/stripe-client.server";

// Platform-side Stripe webhook. Handles SaaS subscription and invoice events for
// tenant organizations (separate from the tenant-facing hook at /api/public/hooks/stripe).
//
// Configure the platform Stripe account with:
//   PLATFORM_STRIPE_SECRET_KEY
//   PLATFORM_STRIPE_WEBHOOK_SECRET
// Endpoint URL to register in Stripe: /api/public/hooks/platform-stripe
// Recommended events:
//   invoice.created, invoice.finalized, invoice.paid, invoice.payment_failed,
//   invoice.voided, invoice.marked_uncollectible,
//   customer.subscription.created, customer.subscription.updated, customer.subscription.deleted,
//   customer.subscription.trial_will_end,
//   customer.created, customer.updated,
//   charge.refunded
//
// That list is the THIRTEEN events the live endpoint actually enables, read
// from the account rather than remembered — it used to name eleven, omitting
// `customer.subscription.trial_will_end`, which has a handler, and
// `charge.refunded`, which did not. An event enabled here and unhandled below
// is answered 200 and looks healthy; the coverage is pinned in
// tests/the-connect-webhook-handles-what-it-subscribes-to.test.ts so the two
// lists cannot drift apart again.

export const Route = createFileRoute("/api/public/hooks/platform-stripe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.PLATFORM_STRIPE_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
        const webhookSecret = process.env.PLATFORM_STRIPE_WEBHOOK_SECRET;
        if (!secret || !webhookSecret) {
          return new Response("Platform Stripe not configured", { status: 501 });
        }
        const signature = request.headers.get("stripe-signature");
        if (!signature) return new Response("Missing signature", { status: 400 });
        const body = await request.text();

        const stripe = await makeStripe(secret);
        let event: import("stripe").Stripe.Event;
        try {
          event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
        } catch (e) {
          console.error("Platform webhook signature failed", e);
          return new Response("Invalid signature", { status: 401 });
        }

        warnOnApiVersionMismatch(event);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Idempotency: skip if already recorded successfully
        const { data: existing } = await supabaseAdmin
          .from("platform_stripe_events")
          .select("id, processed_at")
          .eq("id", event.id)
          .maybeSingle();
        if (existing?.processed_at) return new Response("ok", { status: 200 });

        await supabaseAdmin.from("platform_stripe_events").upsert({
          id: event.id,
          type: event.type,
          payload: event as any,
          received_at: new Date().toISOString(),
        });

        /**
         * The PaymentIntent that paid an invoice, as carried by a payload.
         *
         * Nothing on a Stripe Charge points back to an invoice, so this is the
         * only join a `charge.refunded` handler has, and it has to be captured
         * from the invoice side.
         *
         * This reads `payments` and does NOT fetch it. On a webhook payload it
         * essentially always returns null — see `paymentIntentForInvoice`
         * below, which is what call sites should use.
         */
        function invoicePaymentIntentId(inv: import("stripe").Stripe.Invoice): string | null {
          for (const p of inv.payments?.data ?? []) {
            // Truthiness is the whole check. The SDK documents
            // `payment.payment_intent` as populated only when `payment.type` is
            // `payment_intent` — a `charge`-type entry is surfaced only when
            // there is no payment intent to surface instead — so a `type` guard
            // in front of this could never change the answer. It was here, and
            // it was removed rather than left as a branch no payload can reach
            // and no test can honestly exercise.
            const pi = p.payment?.payment_intent;
            const id = typeof pi === "string" ? pi : pi?.id;
            if (id) return id;
          }
          return null;
        }

        /**
         * The same id, but actually obtainable from a webhook.
         *
         * ── WHAT THE SANDBOX SHOWED, 2026-08-14 ──────────────────────────
         *
         * `Invoice.payments` is an EXPANDABLE list — its own `url` is
         * `/v1/invoices/payments`. Retrieved against the sandbox account
         * (acct_1U0RjEHhx3B6rEuV) the difference is absolute, not occasional:
         *
         *   GET /v1/invoices/{id}                       → no `payments` key
         *   GET /v1/invoices/{id}?expand[]=payments     → payments.data[0] =
         *       { payment: { payment_intent: "pi_…", type: "payment_intent" } }
         *
         * A webhook `data.object` is an unexpanded snapshot. So reading
         * `inv.payments` off an event returns null EVERY time, not merely
         * sometimes as the previous comment here supposed — the column was
         * never once going to be written at invoice time, and every refund
         * would have paid for the list-and-scan fallback instead. That is the
         * same shape of mistake as the first `charge.invoice` attempt: a
         * payload assumed rather than looked at.
         *
         * So ask for it. One retrieve, only when the payload lacked it, and
         * only on the two events where a payment can exist — the InvoicePayment
         * is created at FINALIZE, one second after the invoice in the sandbox
         * run, so `invoice.created` genuinely has nothing to fetch.
         *
         * Wrapped, because a webhook that throws is a webhook Stripe retries
         * for three days over what is only a lookup.
         */
        async function paymentIntentForInvoice(
          inv: import("stripe").Stripe.Invoice,
        ): Promise<string | null> {
          const carried = invoicePaymentIntentId(inv);
          if (carried) return carried;
          if (!inv.id) return null;
          try {
            const full = await stripe.invoices.retrieve(inv.id, { expand: ["payments"] });
            return invoicePaymentIntentId(full);
          } catch (e) {
            // Not fatal: the refund handler still has its own fallback. Loud
            // because a silent miss here is a refund that cannot be linked.
            console.error(`platform invoice ${inv.id}: could not expand payments`, e);
            return null;
          }
        }

        async function orgFromCustomer(
          customerId: string | null | undefined,
        ): Promise<string | null> {
          if (!customerId) return null;
          const { data: org } = await supabaseAdmin
            .from("organizations")
            .select("id")
            .eq("stripe_customer_id", customerId)
            .maybeSingle();
          return org?.id ?? null;
        }

        try {
          switch (event.type) {
            case "invoice.created":
            case "invoice.finalized":
            case "invoice.paid":
            case "invoice.payment_failed":
            case "invoice.voided":
            case "invoice.marked_uncollectible": {
              const inv = event.data.object as import("stripe").Stripe.Invoice;
              const customerId =
                typeof inv.customer === "string" ? inv.customer : (inv.customer?.id ?? null);
              const orgId = await orgFromCustomer(customerId);

              // Only where a payment can exist. `invoice.created` fires before
              // the InvoicePayment does — one second before it, in the sandbox
              // run — and voided/uncollectible invoices were never paid, so
              // fetching for those would be an API call per event that could
              // only ever answer null.
              const paymentIntentId =
                event.type === "invoice.finalized" || event.type === "invoice.paid"
                  ? await paymentIntentForInvoice(inv)
                  : invoicePaymentIntentId(inv);

              // Stripe does not guarantee ORDER and retries for up to 3 days.
              // The per-event idempotency check above is keyed on `event.id`,
              // so it stops a replay of the SAME event and does nothing about a
              // late delivery of a DIFFERENT one. Six event types write this row
              // with a full snapshot, so a retried `invoice.finalized` landing
              // after `invoice.paid` rewound status to 'open', amount_paid to 0
              // and cleared paid_at — and the plan_status mirror below leaves
              // the org alone on that event, so nothing corrected it.
              // listPlatformInvoices then understated collected SaaS revenue
              // with nothing flagged.
              //
              // A paid invoice is terminal for these purposes. Skip any event
              // that would move it backwards; `invoice.voided` and
              // `invoice.marked_uncollectible` are allowed through because they
              // are genuine later transitions rather than stale snapshots.
              const rewindable =
                event.type === "invoice.created" || event.type === "invoice.finalized";
              if (rewindable) {
                const { data: existing } = await supabaseAdmin
                  .from("platform_invoices")
                  .select("status")
                  .eq("stripe_invoice_id", inv.id ?? event.id)
                  .maybeSingle();
                if (existing?.status === "paid" && inv.status !== "paid") {
                  console.warn(
                    `platform invoice ${inv.id}: ignoring a late ${event.type} that would rewind a paid invoice`,
                  );
                  break;
                }
              }

              await supabaseAdmin.from("platform_invoices").upsert(
                {
                  stripe_invoice_id: inv.id ?? event.id,
                  organization_id: orgId as string,
                  number: inv.number ?? null,
                  amount_due_cents: inv.amount_due ?? 0,
                  amount_paid_cents: inv.amount_paid ?? 0,
                  currency: inv.currency ?? "usd",
                  status: inv.status ?? "open",
                  hosted_invoice_url: inv.hosted_invoice_url ?? null,
                  invoice_pdf: inv.invoice_pdf ?? null,
                  period_start: inv.period_start
                    ? new Date(inv.period_start * 1000).toISOString()
                    : null,
                  period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
                  issued_at: inv.created ? new Date(inv.created * 1000).toISOString() : null,
                  due_at: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
                  paid_at:
                    inv.status === "paid" && inv.status_transitions?.paid_at
                      ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
                      : null,
                  // Captured here because a refund cannot find its way back on
                  // its own — see 20260814050000. Written only when we actually
                  // have one, so a later event that does resolve it fills the
                  // gap rather than a null overwriting a good value.
                  ...(paymentIntentId ? { stripe_payment_intent_id: paymentIntentId } : {}),
                },
                { onConflict: "stripe_invoice_id" },
              );

              // Seats: a renewal Stripe has just drafted gets the seat period
              // that just closed, as its own dated line, while it is still a
              // draft (seat-rule.ts). Never fails the webhook: the period is
              // claimed exactly once, and the nightly sweep charges it on an
              // invoice of its own if this did not.
              if (event.type === "invoice.created" && orgId) {
                try {
                  const { chargeSeatsOnRenewalInvoice } =
                    await import("@/lib/seat-reconcile.server");
                  await chargeSeatsOnRenewalInvoice(inv);
                } catch (e) {
                  console.error(
                    `platform invoice ${inv.id}: seat charge failed`,
                    (e as Error).message,
                  );
                }
              }

              // Mirror plan status hints from invoice outcomes.
              //
              // `billing_status` moves with it. It used not to, anywhere in
              // this file, and that column is the one MRR, active_tenants and
              // the /platform/tenants chip all read — so a tenant who paid and
              // never opened Settings → Billing read as `free` forever. See
              // src/lib/platform-billing-status.server.ts.
              const invoiceMovesStatus =
                event.type === "invoice.paid" || event.type === "invoice.payment_failed";
              if (orgId && invoiceMovesStatus) {
                const next = event.type === "invoice.payment_failed" ? "past_due" : "active";
                await supabaseAdmin
                  .from("organizations")
                  .update({ plan_status: next })
                  .eq("id", orgId);
                const { applyPlatformBillingStatus } =
                  await import("@/lib/platform-billing-status.server");
                await applyPlatformBillingStatus(supabaseAdmin, orgId as string, next, {
                  source: "platform_webhook",
                  detail: { event: event.type, invoice: inv.id ?? null },
                });
              }
              break;
            }
            case "customer.subscription.trial_will_end": {
              // Stripe fires this three days out. Warning a trialing tenant
              // before their card is charged is the cheapest churn lever there
              // is — and its absence is worse than neutral, because a charge
              // nobody expected is what produces a dispute rather than a
              // cancellation.
              const sub = event.data.object as import("stripe").Stripe.Subscription;
              const customerId =
                typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
              const trialOrgId = await orgFromCustomer(customerId);
              if (!trialOrgId) break;
              const endsAt = sub.trial_end ? new Date(sub.trial_end * 1000) : null;
              try {
                const { notifyRoles } = await import("@/lib/notify-center.server");
                await notifyRoles(["owner"], {
                  orgId: trialOrgId,
                  type: "trial_ending",
                  title: "Your trial ends soon",
                  body: endsAt
                    ? `Your free trial ends on ${endsAt.toLocaleDateString("en-US", { month: "long", day: "numeric" })}, and your card will be charged then. Change or cancel your plan in Settings → Plan & billing before that if you need to.`
                    : "Your free trial is ending and your card will be charged. Change or cancel your plan in Settings → Plan & billing before that if you need to.",
                  link: "/settings/billing",
                });
              } catch (e) {
                console.error("trial-ending notification failed", (e as Error).message);
              }
              break;
            }
            case "customer.subscription.created":
            case "customer.subscription.updated":
            case "customer.subscription.deleted": {
              const sub = event.data.object as import("stripe").Stripe.Subscription;
              // The in-app Payment Element flow creates the subscription with
              // payment_behavior "default_incomplete", i.e. BEFORE the org has
              // paid. Ignore that pre-payment state (and its 24h expiry) so an
              // opened-then-abandoned payment form never marks the org past_due
              // or canceled; activation arrives via the incomplete → active
              // subscription.updated event (or invoice.paid).
              if (sub.status === "incomplete" || sub.status === "incomplete_expired") break;
              const customerId =
                typeof sub.customer === "string" ? sub.customer : (sub.customer?.id ?? null);
              const orgId = await orgFromCustomer(customerId);
              if (orgId && event.type === "customer.subscription.deleted") {
                // Explicitly canceling a stale incomplete sub (retrying the
                // payment form, switching plans mid-attempt) emits deleted with
                // status "canceled". Only the org's RECORDED subscription may
                // cancel the plan and kill add-ons; incomplete subs are never
                // persisted, so an unknown sub id here is one of those.
                const { data: orgRow } = await supabaseAdmin
                  .from("organizations")
                  .select("stripe_subscription_id")
                  .eq("id", orgId)
                  .maybeSingle();
                if ((orgRow as any)?.stripe_subscription_id !== sub.id) break;
                // The final seat period has no renewal invoice to ride on, so
                // it is charged now, once, on an invoice of its own
                // (seat-rule.ts). Never fails the webhook.
                try {
                  const { chargeFinalSeatPeriods } = await import("@/lib/seat-reconcile.server");
                  await chargeFinalSeatPeriods(sub);
                } catch (e) {
                  console.error(
                    `subscription ${sub.id}: final seat charge failed`,
                    (e as Error).message,
                  );
                }
              }
              if (orgId) {
                const statusMap: Record<string, "active" | "past_due" | "canceled" | "free"> = {
                  trialing: "active",
                  active: "active",
                  past_due: "past_due",
                  canceled: "canceled",
                  unpaid: "past_due",
                  paused: "canceled",
                  incomplete: "past_due",
                  incomplete_expired: "canceled",
                };
                const { subscriptionPeriodEnd } = await import("@/lib/billing-state.server");
                const currentPeriodEnd = subscriptionPeriodEnd(sub);
                const mapped = statusMap[sub.status] ?? "active";
                const orgUpdate: Record<string, unknown> = {
                  stripe_subscription_id: sub.id,
                  plan_status: mapped,
                  // Omit rather than null when unresolvable: don't wipe a
                  // stored renewal date on an event that lacks item data.
                  ...(currentPeriodEnd
                    ? { current_period_end: new Date(currentPeriodEnd * 1000).toISOString() }
                    : {}),
                };
                // Propagate plan identity: subscriptions created/switched by
                // the app carry plan_id in metadata. Only overwrite when the
                // metadata names a REAL catalog plan (cheap select), and never
                // on deletion — a canceled org keeps its last plan for display.
                const metaPlanId = sub.metadata?.plan_id;
                if (metaPlanId && event.type !== "customer.subscription.deleted") {
                  const { data: planRow } = await supabaseAdmin
                    .from("platform_plans")
                    .select("id")
                    .eq("id", metaPlanId)
                    .maybeSingle();
                  if ((planRow as any)?.id) orgUpdate.plan_id = metaPlanId;
                }
                await supabaseAdmin
                  .from("organizations")
                  .update(orgUpdate as any)
                  .eq("id", orgId);
                // The same status against the column the console actually
                // reads. Deliberately a second write rather than a field on
                // `orgUpdate`: it refuses to overwrite an admin suspension, and
                // it files the conversion event "Converted this month" has been
                // counting since the day it shipped.
                const { applyPlatformBillingStatus } =
                  await import("@/lib/platform-billing-status.server");
                await applyPlatformBillingStatus(supabaseAdmin, orgId, mapped, {
                  source: "platform_webhook",
                  detail: { event: event.type, subscription: sub.id, stripe_status: sub.status },
                });
                // A dead subscription takes its bolt-on add-ons with it: mark
                // them canceled and switch their feature flags off, so the org
                // doesn't keep paid features free (and can re-buy cleanly).
                if (event.type === "customer.subscription.deleted" || mapped === "canceled") {
                  try {
                    const { deactivateOrgPlatformAddons } =
                      await import("@/lib/platform-addons.server");
                    await deactivateOrgPlatformAddons(orgId);
                  } catch (e) {
                    console.error(
                      "addon deactivation on subscription end failed",
                      (e as Error).message,
                    );
                  }
                }
              }
              break;
            }
            case "charge.refunded": {
              // Stripe does not reduce `invoice.amount_paid` on a refund: the
              // invoice stays `paid` at its full amount and the money coming
              // back lives only on the charge. Without this, a refunded
              // HoundStack subscription payment is counted as collected for
              // ever, and the refunded customer sees the invoice paid in full
              // in Settings → Billing.
              const charge = event.data.object as import("stripe").Stripe.Charge;
              const pi =
                typeof charge.payment_intent === "string"
                  ? charge.payment_intent
                  : (charge.payment_intent?.id ?? null);
              if (!pi) {
                // A charge with no payment intent is not a subscription
                // payment. Nothing on this account creates one, but saying so
                // beats wondering later why a refund went unrecorded.
                console.warn(
                  `platform charge.refunded ${charge.id}: no payment intent, nothing to link`,
                );
                break;
              }

              const { data: byPi } = await supabaseAdmin
                .from("platform_invoices")
                .select("id")
                .eq("stripe_payment_intent_id", pi)
                .maybeSingle();

              let invoiceRowId = (byPi as { id?: string } | null)?.id ?? null;

              // Fallback for rows written before the column existed, or whose
              // payload carried no `payments` list. Bounded, and it backfills
              // so this costs one lookup per invoice ever rather than one per
              // refund.
              if (!invoiceRowId) {
                const customerId =
                  typeof charge.customer === "string"
                    ? charge.customer
                    : (charge.customer?.id ?? null);
                if (customerId) {
                  // Wrapped, because this is a best-effort backfill and not the
                  // event. Letting a transient Stripe error escape would fail
                  // the whole delivery and have Stripe retry it for three days
                  // over a lookup that was only ever an optimisation — and the
                  // outer catch would mark the event errored, so the retry
                  // would keep finding work to do.
                  try {
                    const list = await stripe.invoices.list({
                      customer: customerId,
                      limit: 100,
                      expand: ["data.payments"],
                    });
                    const match = list.data.find((i) => invoicePaymentIntentId(i) === pi);
                    if (match?.id) {
                      const { data: row } = await supabaseAdmin
                        .from("platform_invoices")
                        .update({ stripe_payment_intent_id: pi })
                        .eq("stripe_invoice_id", match.id)
                        .select("id")
                        .maybeSingle();
                      invoiceRowId = (row as { id?: string } | null)?.id ?? null;
                    } else if (list.has_more) {
                      console.warn(
                        `platform charge.refunded ${charge.id}: payment intent ${pi} not in the ` +
                          `first 100 invoices for ${customerId}, and there are more`,
                      );
                    }
                  } catch (e) {
                    console.error(
                      `platform charge.refunded ${charge.id}: invoice lookup for ${pi} failed`,
                      (e as Error).message,
                    );
                  }
                }
              }

              if (!invoiceRowId) {
                // Loud rather than quiet. An unlinked refund is a wrong revenue
                // figure, and the only thing worse than that is one nobody can
                // find.
                console.error(
                  `platform charge.refunded ${charge.id}: no platform_invoices row for payment intent ${pi}; ` +
                    `refund of ${charge.amount_refunded} NOT recorded and collected revenue is overstated by it`,
                );
                break;
              }

              // SET, never add. `amount_refunded` is already Stripe's running
              // total for the charge, and this event redelivers for up to three
              // days — adding would climb past the charge on the second
              // delivery, which the CHECK from 20260814020000 then rejects.
              //
              // Dated by the REFUND, not the charge: `charge.created` is the
              // original payment, eleven months earlier on an annual plan.
              const latestRefundAt = charge.refunds?.data?.[0]?.created ?? null;
              const { error: refErr } = await supabaseAdmin
                .from("platform_invoices")
                .update({
                  refunded_cents: charge.amount_refunded ?? 0,
                  refunded_at: latestRefundAt
                    ? new Date(latestRefundAt * 1000).toISOString()
                    : new Date().toISOString(),
                })
                .eq("id", invoiceRowId);
              if (refErr) throw new Error(refErr.message);
              break;
            }

            case "customer.created":
            case "customer.updated": {
              // Nothing required — customer→org mapping happens when the org gets
              // stripe_customer_id set during checkout.
              break;
            }
          }

          await supabaseAdmin
            .from("platform_stripe_events")
            .update({ processed_at: new Date().toISOString() })
            .eq("id", event.id);
          return new Response("ok", { status: 200 });
        } catch (e) {
          const msg = (e as Error).message;
          console.error("platform-stripe handler failed", event.type, msg);
          // See the same call in hooks/stripe.ts.
          const { reportServerError } = await import("@/lib/monitoring/report.server");
          await reportServerError(e, {
            request,
            force: true,
            tags: { hook: "platform-stripe", stripe_event: event.type },
          });
          await supabaseAdmin
            .from("platform_stripe_events")
            .update({ error: msg })
            .eq("id", event.id);
          return new Response("handler error", { status: 500 });
        }
      },
    },
  },
});
