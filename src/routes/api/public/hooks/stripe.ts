import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import { feeReversalCents } from "@/lib/platform-fee";
import { makeStripe, warnOnApiVersionMismatch } from "@/lib/stripe-client.server";

async function provisionSignup(
  supabaseAdmin: SupabaseClient,
  signupRequestId: string,
  // Works for both flows: legacy hosted Checkout (session id) and the
  // in-app Payment Element (payment intent id).
  paid: { amountTotalCents: number; stripeRef: string },
) {
  const { data: sr, error } = await supabaseAdmin
    .from("signup_requests")
    .select("*")
    .eq("id", signupRequestId)
    .single();
  if (error || !sr) {
    console.error("provisionSignup: signup_request not found", signupRequestId, error);
    return;
  }
  if (sr.status === "provisioned" && sr.provisioned_client_id) return;

  try {
    // Create client
    const { data: client, error: cErr } = await supabaseAdmin
      .from("clients")
      .insert({
        organization_id: sr.organization_id,
        display_name: sr.name,
        account_type: "residential",
        primary_email: sr.email,
        primary_phone: sr.phone,
      })
      .select("id, portal_token")
      .single();
    if (cErr || !client) throw new Error(cErr?.message || "client insert failed");

    // Create property
    const { data: property, error: pErr } = await supabaseAdmin
      .from("properties")
      .insert({
        organization_id: sr.organization_id,
        client_id: client.id,
        label: "Home",
        street: sr.street,
        city: sr.city,
        region: sr.region,
        postal_code: sr.postal_code,
        country: "US",
      })
      .select("id")
      .single();
    if (pErr || !property) throw new Error(pErr?.message || "property insert failed");

    // Create subscription (prepaid, active)
    const { error: subErr } = await supabaseAdmin.from("subscriptions").insert({
      organization_id: sr.organization_id,
      client_id: client.id,
      property_id: property.id,
      account_type: "residential",
      frequency: sr.frequency,
      price_cents: sr.recurring_price_cents,
      billing_cadence: "prepaid",
      dog_count: sr.dog_count,
      zone_id: sr.zone_id,
      status: "active",
      started_on: new Date().toISOString().slice(0, 10),
    });
    if (subErr) throw new Error(subErr.message);

    // Credit the prepay portion to the client's balance
    const prepay = paid.amountTotalCents - (sr.initial_cleanup_cents ?? 0);
    if (prepay > 0) {
      await supabaseAdmin.from("credit_ledger").insert({
        organization_id: sr.organization_id,
        client_id: client.id,
        delta_cents: prepay,
        kind: "prepayment",
        note: `Signup prepay via Stripe ${paid.stripeRef}`,
      });
    }

    await supabaseAdmin
      .from("signup_requests")
      .update({
        status: "provisioned",
        provisioned_client_id: client.id,
      })
      .eq("id", signupRequestId);

    // Best-effort welcome email
    try {
      const { buildPortalLink } = await import("@/lib/portal-links.server");
      const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
      await enqueueAppEmail({
        organizationId: sr.organization_id,
        clientId: client.id,
        templateName: "welcome",
        notifyKey: "notify_email_welcome",
        idempotencyKey: `welcome-signup-${signupRequestId}`,
        templateData: {
          portalUrl: await buildPortalLink(
            sr.organization_id,
            client.portal_token as string | null,
          ),
        },
      });
    } catch (e) {
      console.error("signup welcome email failed", e);
    }
  } catch (e) {
    console.error("provisionSignup failed", e);
    await supabaseAdmin
      .from("signup_requests")
      .update({ status: "failed", error_message: (e as Error).message })
      .eq("id", signupRequestId);
  }
}

export const Route = createFileRoute("/api/public/hooks/stripe")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // Connect webhook: tenant->client charge events for connected accounts,
        // verified with the Connect platform's webhook secret. Platform SaaS
        // billing events go to /api/public/hooks/platform-stripe, not here.
        //
        // NO FALLBACK TO THE PLATFORM VARS, deliberately. Both of these used to
        // read `CONNECT ?? platform`, which is harmless only while one Stripe
        // account plays both roles. The moment the Connect platform and the
        // subscription-billing account are separate — which the rest of this
        // codebase already allows, and which `connectSecret()` has always
        // assumed by throwing rather than falling back — that fallback becomes
        // the worst kind of bug:
        //
        //   the key      authenticates against an account that does not own
        //                these connected accounts, so every lookup misses;
        //   the secret   verifies signatures against the wrong signing secret,
        //                which is indistinguishable from an attacker, so every
        //                event is rejected exactly as designed.
        //
        // Both fail silently while still returning 200 to Stripe. A missing
        // variable is a configuration mistake and should read as one.
        const secret = process.env.STRIPE_CONNECT_SECRET_KEY;
        const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET;
        if (!secret || !webhookSecret) {
          console.error(
            "Connect webhook not configured: STRIPE_CONNECT_SECRET_KEY and " +
              "STRIPE_CONNECT_WEBHOOK_SECRET must both be set, and must both belong to " +
              "the Stripe account that owns the connected accounts.",
          );
          return new Response("Stripe not configured", { status: 500 });
        }
        const signature = request.headers.get("stripe-signature");
        if (!signature) return new Response("Missing signature", { status: 400 });
        const body = await request.text();

        const stripe = await makeStripe(secret);
        let event: import("stripe").Stripe.Event;
        try {
          event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
        } catch (e) {
          console.error("Webhook signature verification failed", e);
          return new Response("Invalid signature", { status: 401 });
        }

        warnOnApiVersionMismatch(event);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { resolveOrgStripeAccount } = await import("@/lib/stripe-connect.server");

        // Security (C1): a Connect event's metadata is fully controllable by the
        // account that produced it, but `event.account` is trustworthy. Never
        // mutate an org/invoice/client referenced by metadata unless it actually
        // belongs to the connected account that produced the event — otherwise a
        // tenant could mark another tenant's invoice paid / hijack their card by
        // putting a victim id in their own event's metadata.
        async function accountMatches(orgId: string | null | undefined): Promise<boolean> {
          if (!orgId || !event.account) return false;
          const a = await resolveOrgStripeAccount(orgId);
          return !!a && a.accountId === event.account;
        }

        try {
          if (event.type === "account.application.deauthorized") {
            // A tenant disconnected HoundStack from THEIR Stripe dashboard.
            //
            // The in-app Disconnect button clears this state itself; this is the
            // other half — the case where the tenant never touches our UI. Until
            // now nothing handled it, so the org kept `charges_enabled = true`
            // forever, every subsequent charge failed at the Stripe API, and
            // neither the tenant nor the platform got a signal saying why.
            //
            // `event.account` is the only trustworthy identifier on a Connect
            // event (see accountMatches above) and is exactly what we key on, so
            // no metadata is consulted and nothing else can be affected.
            if (event.account) {
              const { error } = await (supabaseAdmin as any)
                .from("organizations")
                .update({
                  stripe_connect_charges_enabled: false,
                  stripe_connect_status: "disconnected",
                  // The account id is deliberately KEPT. It is the audit trail of
                  // which account was connected, the tenant may reconnect the
                  // same one, and clearing it would strand every saved card and
                  // customer id that points at it.
                })
                .eq("stripe_connect_account_id", event.account);
              if (error) console.error("deauthorize update failed", event.account, error);
              else console.warn("connected account deauthorized by tenant", event.account);
            }
            return new Response("ok", { status: 200 });
          }

          if (event.type === "setup_intent.succeeded") {
            // The durable backstop for saving a card.
            //
            // Both inline flows confirm the SetupIntent in the browser and then
            // call a server function (portalFinalizeCardSetup / the staff
            // equivalent) to record the payment method. If the tab closes, the
            // network drops, or the user navigates away in between, the card
            // exists at Stripe and does not exist in HoundStack — so autopay
            // silently never runs for that client and nothing reports it.
            //
            // This handler is that same write, driven by an event that survives
            // the browser going away. It is idempotent: writing the same
            // payment method id twice is a no-op, so the ordinary path racing
            // this one is harmless.
            const si = event.data.object as import("stripe").Stripe.SetupIntent;
            const clientId = si.metadata?.client_id;
            const source = si.metadata?.source;
            if (clientId && (source === "portal_setup_inline" || source === "staff_setup_inline")) {
              const { data: setupClient } = await supabaseAdmin
                .from("clients")
                .select("organization_id")
                .eq("id", clientId)
                .maybeSingle();
              // C1 again: metadata is attacker-controlled, event.account is not.
              if (await accountMatches((setupClient as any)?.organization_id)) {
                try {
                  const acctOpts = event.account ? { stripeAccount: event.account } : undefined;
                  const pmId =
                    typeof si.payment_method === "string"
                      ? si.payment_method
                      : si.payment_method?.id;
                  const customerId =
                    typeof si.customer === "string" ? si.customer : si.customer?.id;
                  if (pmId && customerId) {
                    const pm = await stripe.paymentMethods.retrieve(pmId, undefined, acctOpts);
                    await stripe.customers.update(
                      customerId,
                      {
                        invoice_settings: { default_payment_method: pmId },
                      },
                      acctOpts,
                    );
                    await supabaseAdmin
                      .from("clients")
                      .update({
                        stripe_customer_id: customerId,
                        default_payment_method_id: pmId,
                        default_card_brand: pm.card?.brand ?? null,
                        default_card_last4: pm.card?.last4 ?? null,
                        // Same rule as the Checkout path: only the client's own
                        // portal flow opts them into autopay. A staff-added card
                        // must not change a preference the client set.
                        ...(source === "portal_setup_inline" ? { autopay_enabled: true } : {}),
                      })
                      .eq("id", clientId);
                  }
                } catch (e) {
                  console.error("setup_intent.succeeded finalize failed", si.id, e);
                }
              }
            }
            return new Response("ok", { status: 200 });
          }

          if (event.type === "checkout.session.completed") {
            const session = event.data.object as import("stripe").Stripe.Checkout.Session;

            // Saved-card setup flows: portal_setup (client, enrolls autopay)
            // and staff_setup (office-added card, autopay preference untouched)
            if (
              session.mode === "setup" &&
              (session.metadata?.source === "portal_setup" ||
                session.metadata?.source === "staff_setup")
            ) {
              const clientId = session.metadata.client_id;
              const setupIntentId =
                typeof session.setup_intent === "string"
                  ? session.setup_intent
                  : (session.setup_intent?.id ?? null);
              // C1: the client must belong to the account that produced the event.
              const { data: setupClient } = clientId
                ? await supabaseAdmin
                    .from("clients")
                    .select("organization_id")
                    .eq("id", clientId)
                    .maybeSingle()
                : { data: null };
              if (
                clientId &&
                setupIntentId &&
                (await accountMatches((setupClient as any)?.organization_id))
              ) {
                try {
                  // Connect: these objects live on the connected account.
                  const acctOpts = event.account ? { stripeAccount: event.account } : undefined;
                  const si = await stripe.setupIntents.retrieve(setupIntentId, undefined, acctOpts);
                  const pmId =
                    typeof si.payment_method === "string"
                      ? si.payment_method
                      : si.payment_method?.id;
                  const customerId =
                    typeof si.customer === "string" ? si.customer : si.customer?.id;
                  if (pmId && customerId) {
                    const pm = await stripe.paymentMethods.retrieve(pmId, undefined, acctOpts);
                    await stripe.customers.update(
                      customerId,
                      {
                        invoice_settings: { default_payment_method: pmId },
                      },
                      acctOpts,
                    );
                    await supabaseAdmin
                      .from("clients")
                      .update({
                        stripe_customer_id: customerId,
                        default_payment_method_id: pmId,
                        default_card_brand: pm.card?.brand ?? null,
                        default_card_last4: pm.card?.last4 ?? null,
                        // Only the client's own portal flow opts them into
                        // autopay; a staff-added card must not.
                        ...(session.metadata?.source === "portal_setup"
                          ? { autopay_enabled: true }
                          : {}),
                      })
                      .eq("id", clientId);
                  }
                } catch (e) {
                  console.error("portal_setup finalize failed", e);
                }
              }
              return new Response("ok", { status: 200 });
            }

            const signupRequestId = session.metadata?.signup_request_id;
            if (signupRequestId) {
              const { data: sr } = await supabaseAdmin
                .from("signup_requests")
                .select("organization_id")
                .eq("id", signupRequestId)
                .maybeSingle();
              if (await accountMatches((sr as any)?.organization_id)) {
                await provisionSignup(supabaseAdmin, signupRequestId, {
                  amountTotalCents: session.amount_total ?? 0,
                  stripeRef: session.id,
                });
              } else {
                console.error("signup webhook account mismatch", {
                  signupRequestId,
                  eventAccount: event.account,
                });
              }
              return new Response("ok", { status: 200 });
            }

            const invoiceId = session.metadata?.invoice_id || session.client_reference_id;
            const pi =
              typeof session.payment_intent === "string"
                ? session.payment_intent
                : (session.payment_intent?.id ?? null);
            if (invoiceId) {
              const { data: inv } = await supabaseAdmin
                .from("invoices")
                .select("id, organization_id, total_cents, currency, status")
                .eq("id", invoiceId)
                .single();
              // C1 + M1: the invoice must belong to the event's account, and skip
              // if already paid (Stripe retries/redelivers). The atomic claim in
              // markInvoicePaidFromStripe also protects against racing the
              // reconcile fallback.
              if (inv && inv.status !== "paid" && (await accountMatches(inv.organization_id))) {
                const { markInvoicePaidFromStripe } =
                  await import("@/lib/invoice-reconcile.server");
                await markInvoicePaidFromStripe(supabaseAdmin, {
                  invoiceId: inv.id,
                  organizationId: inv.organization_id,
                  amountCents: session.amount_total ?? inv.total_cents,
                  currency: session.currency ?? inv.currency,
                  paymentIntentId: pi,
                  checkoutSessionId: session.id,
                  raw: event,
                });
              }
            }
          } else if (event.type === "payment_intent.succeeded") {
            const pi = event.data.object as import("stripe").Stripe.PaymentIntent;

            // In-app signup prepay (Payment Element): provision the client
            // once the intent settles, same account-match rule as Checkout.
            const piSignupId = pi.metadata?.signup_request_id;
            if (piSignupId && pi.metadata?.source === "signup_inline") {
              const { data: sr } = await supabaseAdmin
                .from("signup_requests")
                .select("organization_id")
                .eq("id", piSignupId)
                .maybeSingle();
              if (await accountMatches((sr as any)?.organization_id)) {
                await provisionSignup(supabaseAdmin, piSignupId, {
                  amountTotalCents: pi.amount,
                  stripeRef: pi.id,
                });
              } else {
                console.error("signup webhook account mismatch", {
                  signupRequestId: piSignupId,
                  eventAccount: event.account,
                });
              }
              return new Response("ok", { status: 200 });
            }

            const invoiceId = pi.metadata?.invoice_id;
            // Only handle PI-first flows (saved card, autopay, portal + staff
            // inline Payment Element, public pay link); Checkout flows are
            // already finalized above via checkout.session.completed and
            // their PIs carry no invoice metadata.
            const source = pi.metadata?.source;
            if (
              invoiceId &&
              (source === "portal_saved_card" ||
                source === "autopay" ||
                source === "portal_inline" ||
                source === "staff_inline" ||
                source === "staff_saved_card" ||
                source === "public_link")
            ) {
              const { data: inv } = await supabaseAdmin
                .from("invoices")
                .select("id, organization_id, total_cents, currency, status, client_id")
                .eq("id", invoiceId)
                .single();
              if (inv && inv.status !== "paid" && (await accountMatches(inv.organization_id))) {
                const { markInvoicePaidFromStripe } =
                  await import("@/lib/invoice-reconcile.server");
                // A pass-through charge is base + surcharge. Only the base pays
                // down the invoice: the surcharge is the tenant recovering
                // Stripe's fee, not the homeowner paying more for the service.
                // Handing `pi.amount` in here would over-credit the invoice and
                // report the recovery as revenue everywhere revenue is summed.
                const { invoiceAppliedCents, surchargeFromMetadata } =
                  await import("@/lib/processing-fee.server");
                const claimed = await markInvoicePaidFromStripe(supabaseAdmin, {
                  invoiceId: inv.id,
                  organizationId: inv.organization_id,
                  amountCents: invoiceAppliedCents(pi.amount, pi.metadata),
                  surchargeCents: surchargeFromMetadata(pi.metadata),
                  currency: pi.currency,
                  paymentIntentId: pi.id,
                  raw: event,
                });
                // Successful autopay clears the dunning failure ladder.
                if (claimed) {
                  await supabaseAdmin
                    .from("clients")
                    .update({
                      autopay_failure_count: 0,
                      autopay_paused: false,
                      autopay_last_error: null,
                      autopay_last_attempt_at: new Date().toISOString(),
                    })
                    .eq("id", inv.client_id);
                }
              }
            }
          } else if (event.type === "payment_intent.payment_failed") {
            const pi = event.data.object as import("stripe").Stripe.PaymentIntent;
            const invoiceId = pi.metadata?.invoice_id;
            if (invoiceId) {
              // C1: ignore unless the invoice belongs to the event's account.
              const { data: invOwner } = await supabaseAdmin
                .from("invoices")
                .select("organization_id")
                .eq("id", invoiceId)
                .maybeSingle();
              if (!(await accountMatches((invOwner as any)?.organization_id))) {
                console.error("payment_failed webhook account mismatch", {
                  invoiceId,
                  eventAccount: event.account,
                });
                return new Response("ok", { status: 200 });
              }
              // BUILD-6: a failed charge never counts toward revenue (settlement
              // filters status='succeeded'), but leaving provenance null here
              // would make the column mean "succeeded payments only" in
              // practice while claiming to describe every row.
              const { collectingOrgIdFor } = await import("@/lib/stripe-connect.server");
              // Same split as the succeeded path: `amount_cents` means money
              // toward the invoice on every row, so a failed pass-through charge
              // does not read as a larger attempt than the invoice was for.
              const { invoiceAppliedCents, surchargeFromMetadata } =
                await import("@/lib/processing-fee.server");
              await supabaseAdmin.from("payments").insert({
                organization_id: (invOwner as any).organization_id,
                collected_by_organization_id: await collectingOrgIdFor(
                  (invOwner as any).organization_id,
                ),
                invoice_id: invoiceId,
                amount_cents: invoiceAppliedCents(pi.amount, pi.metadata),
                surcharge_cents: surchargeFromMetadata(pi.metadata),
                currency: pi.currency,
                status: "failed",
                stripe_payment_intent_id: pi.id,
                raw_event: JSON.parse(JSON.stringify(event)),
              });
              // Dunning (failure ladder, autopay pause, "card declined" SMS)
              // applies only to charges against the SAVED card. A typo in the
              // inline Payment Element (staff_inline / portal_inline /
              // signup_inline) is a live person retrying a form, not a broken
              // card on file — the failed payment row above is enough.
              const failSource = pi.metadata?.source;
              const isSavedCardCharge =
                failSource === "autopay" || failSource === "portal_saved_card";
              // A staff-initiated saved-card charge that declines is still a
              // decline of the CARD ON FILE: record card health so the
              // Billing tab shows it, but don't escalate (no failure count,
              // no autopay pause, no SMS — staff saw the error live).
              if (failSource === "staff_saved_card") {
                const { data: failInv } = await supabaseAdmin
                  .from("invoices")
                  .select("client_id")
                  .eq("id", invoiceId)
                  .maybeSingle();
                if ((failInv as any)?.client_id) {
                  await supabaseAdmin
                    .from("clients")
                    .update({
                      autopay_last_error: pi.last_payment_error?.message ?? "Card charge failed",
                      autopay_last_attempt_at: new Date().toISOString(),
                    })
                    .eq("id", (failInv as any).client_id);
                }
              }
              // Record error on client for autopay visibility
              const err = pi.last_payment_error?.message ?? "Card charge failed";
              const { data: inv } = await supabaseAdmin
                .from("invoices")
                .select("client_id, organization_id")
                .eq("id", invoiceId)
                .single();
              if (inv?.client_id && isSavedCardCharge) {
                // Dunning: increment failure count, pause autopay if past org threshold.
                const [{ data: c }, { data: orgCfg }] = await Promise.all([
                  supabaseAdmin
                    .from("clients")
                    .select("autopay_failure_count")
                    .eq("id", inv.client_id)
                    .single(),
                  supabaseAdmin
                    .from("organizations")
                    .select("dunning_pause_after_failures")
                    .eq("id", inv.organization_id)
                    .single(),
                ]);
                const nextCount = (c?.autopay_failure_count ?? 0) + 1;
                const threshold = orgCfg?.dunning_pause_after_failures ?? 3;
                await supabaseAdmin
                  .from("clients")
                  .update({
                    autopay_last_error: err,
                    autopay_last_attempt_at: new Date().toISOString(),
                    autopay_failure_count: nextCount,
                    autopay_paused: nextCount >= threshold,
                  })
                  .eq("id", inv.client_id);

                // Optional SMS alert to client (org toggle)
                try {
                  const { data: org } = await supabaseAdmin
                    .from("organizations")
                    .select("sms_from_number, notify_sms_payment_failed")
                    .eq("id", inv.organization_id)
                    .single();
                  // Dunning is an automated notification → PLATFORM Twilio sender.
                  const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
                  const dunningFrom = platformTwilioFrom() ?? org?.sms_from_number ?? null;
                  if (org?.notify_sms_payment_failed && dunningFrom) {
                    const { data: c } = await supabaseAdmin
                      .from("clients")
                      .select(
                        "display_name, primary_phone, sms_opt_out, portal_token, comms_paused",
                      )
                      .eq("id", inv.client_id)
                      .single();
                    // comms_paused: imported clients get no automated dunning
                    // SMS until the org initiates contact.
                    if (c && !c.sms_opt_out && !c.comms_paused && c.primary_phone) {
                      const { sendTwilioSms } = await import("@/lib/twilio.server");
                      const { buildPortalLink } = await import("@/lib/portal-links.server");
                      const url = await buildPortalLink(
                        inv.organization_id,
                        c.portal_token as string | null,
                      );
                      const body = `Hi ${c.display_name}, your card on file was declined. Please update your payment method: ${url}`;
                      const r = await sendTwilioSms({
                        from: dunningFrom,
                        to: c.primary_phone,
                        body,
                      });
                      await supabaseAdmin.from("messages").insert({
                        organization_id: inv.organization_id,
                        client_id: inv.client_id,
                        direction: "outbound",
                        body,
                        from_number: dunningFrom,
                        to_number: c.primary_phone,
                        twilio_sid: r.sid,
                        status:
                          (r.status as
                            "queued" | "sent" | "delivered" | "failed" | "received" | undefined) ??
                          "queued",
                      });
                    }
                  }
                } catch (e) {
                  console.error("payment-failed SMS failed", e);
                }

                // In-app notification to owners/managers.
                try {
                  const { notifyRoles } = await import("@/lib/notify-center.server");
                  await notifyRoles(["owner", "office_manager"], {
                    orgId: inv.organization_id,
                    type: "payment_failed",
                    title: "A client payment failed",
                    body: `Invoice ${invoiceId.slice(0, 8)}: card declined.`,
                    link: "/invoices",
                  });
                } catch (e) {
                  console.error("payment-failed in-app notification failed", e);
                }
              }
            }
          } else if (event.type === "charge.refund.updated") {
            // A refund is NOT final when it is created. `charge.refunded` fires
            // on submission; the refund can still fail afterwards — closed card,
            // rejected ACH return, a bank that will not take it — and Stripe
            // reports that here, moving the refund's status to `failed` or
            // `canceled` and DECREMENTING charge.amount_refunded.
            //
            // Nothing listened for it, so the ledger recorded the refund at
            // submission and kept it for ever: a failed refund permanently
            // removed revenue the tenant still had. The exact inverse of the
            // partial-refund bug, invisible for the same reason — the ledger
            // only ever learned about a refund once.
            const refund = event.data.object as any;
            const chargeId: string | null =
              typeof refund?.charge === "string" ? refund.charge : (refund?.charge?.id ?? null);
            if (!chargeId) return new Response("ok", { status: 200 });

            // Re-read the CHARGE rather than trusting the event's own figure.
            // Its amount_refunded is the current truth — Stripe has already
            // taken the failed refund back out of it — and because we fetched it
            // now, out-of-order delivery does not apply. That is what makes the
            // authoritative write below safe when the monotonic one is not.
            // `stripeAccount` is a REQUEST OPTION, not a param — it belongs in
            // the second options argument, and the charge lives on the connected
            // account, so without it this reads the platform's own charges and
            // finds nothing.
            const charge = await stripe.charges.retrieve(
              chargeId,
              {},
              { stripeAccount: event.account ?? undefined },
            );
            const piId =
              typeof charge.payment_intent === "string"
                ? charge.payment_intent
                : (charge.payment_intent?.id ?? null);
            if (!piId) return new Response("ok", { status: 200 });

            const { data: rpay } = await (supabaseAdmin as any)
              .from("payments")
              .select("id, organization_id, amount_cents, surcharge_cents")
              .eq("stripe_payment_intent_id", piId)
              .maybeSingle();
            if (!rpay) return new Response("ok", { status: 200 });
            if (!(await accountMatches(rpay.organization_id))) {
              return new Response("ok", { status: 200 });
            }

            const trueRefunded = Number(charge.amount_refunded ?? 0);
            const { splitRefund } = await import("@/lib/refund-split");
            const split = splitRefund(
              trueRefunded,
              Number(rpay.amount_cents ?? 0) + Number(rpay.surcharge_cents ?? 0),
              Number(rpay.surcharge_cents ?? 0),
            );
            try {
              await (supabaseAdmin as any).rpc("file_reversal_review_item", {
                _org_id: rpay.organization_id,
                _payment_id: rpay.id,
                _kind: "refund",
                _amount_cents: trueRefunded,
                _revenue_cents: split.revenueCents,
                _adjustment_id: null,
                _dispute_ref: null,
                // Re-read from Stripe, so it REPLACES the stored total. This is
                // the only path that may lower it.
                _authoritative: true,
              });
            } catch (e) {
              console.error("refund reconcile failed", { chargeId, piId }, e);
            }

            // The payment's own status has to follow, or the charge path keeps
            // treating a payment as refunded when the money never went back.
            if (trueRefunded <= 0) {
              await (supabaseAdmin as any)
                .from("payments").update({ status: "succeeded" }).eq("id", rpay.id);
            }

            if (refund?.status === "failed" || refund?.status === "canceled") {
              // Say so. A failed refund is a customer who was told they would be
              // repaid and was not — the tenant has to hear it from us, because
              // the customer will otherwise hear nothing at all.
              try {
                const { notifyRoles } = await import("@/lib/notify-center.server");
                await notifyRoles(["owner", "office_manager"], {
                  orgId: rpay.organization_id,
                  type: "refund_failed",
                  title: "A refund did not go through",
                  body:
                    `A refund of $${(Number(refund?.amount ?? 0) / 100).toFixed(2)} ` +
                    `${refund?.status === "failed" ? "failed" : "was canceled"} — the money has ` +
                    `NOT returned to the customer. Your revenue figures have been corrected. ` +
                    `Contact them before they chase it.`,
                });
              } catch (e) {
                console.error("refund-failed notification failed", e);
              }
            }
          } else if (event.type === "payout.paid" || event.type === "payout.failed") {
            // Money reaching (or failing to reach) the tenant's bank. Their
            // first question and the one thing HoundStack could not answer —
            // the embedded balances component shows it live, but nothing on
            // this side knew, so nothing could notify or report on it.
            const payout = event.data.object as any;
            const { data: porg } = await (supabaseAdmin as any)
              .from("organizations")
              .select("id")
              .eq("stripe_connect_account_id", event.account ?? "")
              .maybeSingle();
            if (!porg) return new Response("ok", { status: 200 });
            const amount = `$${(Number(payout?.amount ?? 0) / 100).toFixed(2)}`;
            const failed = event.type === "payout.failed";
            try {
              const { notifyRoles } = await import("@/lib/notify-center.server");
              await notifyRoles(["owner", "office_manager"], {
                orgId: porg.id,
                type: failed ? "payout_failed" : "payout_paid",
                title: failed ? "A payout failed" : `${amount} is on its way to your bank`,
                body: failed
                  ? // A stale bank account silently halts EVERY payout, not just
                    // this one, and the only place that was visible was Stripe.
                    `${amount} could not be paid out${payout?.failure_message ? `: ${payout.failure_message}` : ""}. ` +
                    `Payouts stay stopped until the bank details are fixed — check Payments.`
                  : `${amount} has been sent to your bank account.`,
              });
            } catch (e) {
              console.error("payout notification failed", e);
            }
          } else if (event.type === "radar.early_fraud_warning.created") {
            // The card network telling us, before the customer does, that this
            // charge is probably fraudulent. It is the strongest predictor of a
            // chargeback there is, and refunding on it avoids the dispute (and
            // the fee) entirely — but only if the tenant hears about it in time.
            const efw = event.data.object as any;
            const { data: forg } = await (supabaseAdmin as any)
              .from("organizations")
              .select("id")
              .eq("stripe_connect_account_id", event.account ?? "")
              .maybeSingle();
            if (!forg) return new Response("ok", { status: 200 });
            try {
              const { notifyRoles } = await import("@/lib/notify-center.server");
              await notifyRoles(["owner", "office_manager"], {
                orgId: forg.id,
                type: "fraud_warning",
                title: "Fraud warning on a payment",
                body:
                  `The card network has flagged a charge as likely fraudulent` +
                  `${efw?.fraud_type ? ` (${String(efw.fraud_type).replace(/_/g, " ")})` : ""}. ` +
                  `Refunding it now usually avoids a chargeback and its fee. Open Payments to review.`,
              });
            } catch (e) {
              console.error("fraud warning notification failed", e);
            }
          } else if (
            event.type === "charge.refunded" ||
            event.type === "charge.dispute.created" ||
            event.type === "charge.dispute.updated" ||
            event.type === "charge.dispute.closed"
          ) {
            // BUILD-6: reversals. Until now the app recorded NONE of these —
            // a refund or chargeback simply never existed as far as HoundStack
            // was concerned, so revenue, reports, and franchise settlements all
            // counted money that had gone back to the customer.
            //
            // These event types must be subscribed on the Stripe endpoint or
            // this branch never runs. Stripe sends only what you select, and
            // for Connect they have to be enabled on the CONNECT endpoint so
            // events raised on connected accounts arrive at all.
            //
            // `charge.dispute.updated` is in that list and is easy to leave out
            // because it sounds like a notification rather than a transaction.
            // It is not: Stripe promotes an inquiry to a real chargeback by
            // changing `status` on the existing dispute, and arbitration flips
            // a won dispute to lost the same way. Money moves on both, and
            // neither raises `created` or `closed`. See planDisputeEvent.
            const obj = event.data.object as any;
            const paymentIntentId: string | null =
              obj?.payment_intent ?? obj?.charge?.payment_intent ?? null;
            if (!paymentIntentId) return new Response("ok", { status: 200 });

            const { data: pay } = await (supabaseAdmin as any)
              .from("payments")
              // surcharge_cents: a refund's amount is the CHARGE total (base +
              // surcharge) but only the base was ever revenue, so the split
              // needs to know how much of this payment was recovered fee.
              .select("id, organization_id, amount_cents, surcharge_cents, status")
              .eq("stripe_payment_intent_id", paymentIntentId)
              .maybeSingle();
            if (!pay) return new Response("ok", { status: 200 });
            // Works for a parent-collected location too: the dispute arrives
            // from the FRANCHISE's connected account, and resolveOrgStripeAccount
            // now returns exactly that account for such a location.
            if (!(await accountMatches(pay.organization_id))) {
              console.error("reversal webhook account mismatch", {
                paymentIntentId,
                eventAccount: event.account,
              });
              return new Response("ok", { status: 200 });
            }

            let kind: string | null = null;
            /** What actually left the account — what the customer got back and
             *  what the alert must quote. */
            let amount = 0;
            /** The share of it that comes off REVENUE. Equal to `amount` for
             *  every non-surcharged payment, which is most of them. */
            let revenueAmount = 0;
            // Stripe's dispute id. THE identity of a dispute — a payment can be
            // disputed more than once over its life (an inquiry that escalates
            // is a new dispute object; a charge can carry two partial disputes),
            // and keying the ledgers on the payment alone silently discarded
            // every dispute after the first.
            let disputeRef: string | null = null;
            let movesMoney = false;

            if (event.type === "charge.refunded") {
              kind = "refund";
              amount = Number(obj?.amount_refunded ?? 0);
              movesMoney = true;

              // Only the invoiced base is revenue. The surcharge was fee
              // recovery, recorded beside the amount rather than inside it, and
              // deducting it here took money off a revenue figure that never
              // contained it — understating the tenant's income by exactly the
              // fee they never earned, on every refunded surcharged payment.
              const { splitRefund } = await import("@/lib/refund-split");
              revenueAmount = splitRefund(
                amount,
                // The charge total: base + surcharge, as stored on the payment.
                Number(pay.amount_cents ?? 0) + Number(pay.surcharge_cents ?? 0),
                Number(pay.surcharge_cents ?? 0),
              ).revenueCents;

              // Give back our 50 bps on the refunded portion.
              //
              // Stripe does not do this by itself. On a DIRECT charge the
              // connected account issues the refund and the platform's
              // application fee stays collected — so without this the tenant is
              // out the refunded amount AND our fee, on a transaction that was
              // unwound. The policy decision lives in src/lib/platform-fee.ts.
              //
              // Idempotent by construction, which is the point of computing a
              // TARGET rather than an increment: `amount_refunded` is cumulative
              // and this event fires once per refund, so reversing
              // `proportion × fee` each time would over-refund from the second
              // partial refund onward. We ask for the total that should have
              // been returned by now, subtract what Stripe says already has
              // been, and send only the difference. A replayed webhook computes
              // a delta of zero and does nothing.
              //
              // `stripe` here is the PLATFORM client — application fees belong
              // to the platform, not to the connected account, so this call must
              // not be scoped with { stripeAccount }.
              //
              // Deliberately isolated: a failure here must not stop the reversal
              // ledger below from recording the refund. The customer getting
              // their money back is the fact that has to be right; our fee is
              // reconcilable afterwards from Stripe's own records.
              const feeId: string | null =
                typeof obj?.application_fee === "string"
                  ? obj.application_fee
                  : (obj?.application_fee?.id ?? null);
              if (feeId) {
                try {
                  const fee = await stripe.applicationFees.retrieve(feeId);
                  const target = feeReversalCents(
                    Number(fee?.amount ?? 0),
                    Number(obj?.amount ?? 0),
                    Number(obj?.amount_refunded ?? 0),
                  );
                  const delta = target - Number(fee?.amount_refunded ?? 0);
                  if (delta > 0) {
                    await stripe.applicationFees.createRefund(feeId, { amount: delta });
                  }
                } catch (e) {
                  console.error(
                    "application fee reversal failed",
                    {
                      feeId,
                      paymentIntentId,
                    },
                    e,
                  );
                }
              }
            } else {
              // BUILD-12: `charge.dispute.created` and `charge.dispute.closed`
              // carry BOTH inquiries and real chargebacks, and only `status`
              // tells them apart. This handler used to read every `created` as a
              // withdrawal and every non-`won` `closed` as a loss — so an
              // inquiry that was simply dropped (`warning_closed`) deducted its
              // amount from revenue for ever and billed a franchise location for
              // money nobody had taken. The decision lives in disputes.ts,
              // pure and unit-tested, because production traffic is the only
              // other thing that exercises it.
              const { planDisputeEvent } = await import("@/lib/disputes");
              const plan = planDisputeEvent(event.type, obj?.status);
              kind = plan.kind;
              movesMoney = plan.movesMoney;
              amount = Number(obj?.amount ?? 0);
              // A chargeback takes the whole charge, surcharge included, and
              // the bank does not itemise it. Left whole on purpose: unlike a
              // refund the tenant does not get to keep the recovered fee
              // either, so the entire amount really is gone.
              revenueAmount = amount;
              disputeRef = typeof obj?.id === "string" ? obj.id : null;
            }

            if (kind) {
              // Franchise apportionment, if this location belongs to one.
              // Returns null for an ordinary independent business.
              //
              // Only for an event that actually moved money. A lost dispute and
              // both inquiry kinds are status facts; the SQL refuses them too,
              // but a guard on both sides of a boundary that decides whether
              // someone is billed is worth the three lines.
              // revenueAmount, NOT amount. The settlement's revenue base is
              // `sum(payments.amount_cents)` — base only, surcharge excluded —
              // so a deduction taken on base + surcharge is computed on a
              // different basis than the revenue it comes off.
              //
              // On a 15% royalty a $100 invoice charged as $103 and refunded
              // deducted $103, billing the location $3.00 more than the revenue
              // that was ever counted, on every refunded surcharged payment.
              // The split was already being computed one line up and handed to
              // the ledger; this call was simply not given it.
              //
              // Identical for a chargeback, where revenueAmount === amount.
              const { data: adjId } = movesMoney
                ? await (supabaseAdmin as any).rpc("record_franchise_adjustment", {
                    _payment_id: pay.id,
                    _kind: kind,
                    _amount_cents: revenueAmount,
                    _note: `Stripe ${event.type}`,
                    _dispute_ref: disputeRef,
                  })
                : { data: null };

              // ALERT, because the owner is right that this WILL happen and
              // silence is the failure mode. Reuses the review queue rather
              // than inventing a second place to look (BUILD-10).
              try {
                await (supabaseAdmin as any).rpc("file_reversal_review_item", {
                  _org_id: pay.organization_id,
                  _payment_id: pay.id,
                  _kind: kind,
                  // What moved — this is the number the alert quotes to the
                  // tenant, and it must match their Stripe dashboard.
                  _amount_cents: amount,
                  // What comes off revenue. Same as the above unless a card
                  // surcharge was collected inside the refunded charge.
                  _revenue_cents: revenueAmount,
                  _adjustment_id: adjId ?? null,
                  _dispute_ref: disputeRef,
                });
              } catch (e) {
                console.error("reversal review item failed", e);
              }

              // Mark the payment so every revenue figure agrees with the bank.
              //
              // Derived from the WHOLE ledger rather than from this one event.
              // Flipping straight to 'succeeded' on a win restored the entire
              // gross of a payment that might still carry a second, open or
              // lost, dispute — and would have erased a refund recorded
              // separately. A refund is left alone here: it has its own status
              // already and no dispute outcome should overrule it.
              if (event.type === "charge.refunded") {
                await (supabaseAdmin as any)
                  .from("payments")
                  .update({ status: "refunded" })
                  .eq("id", pay.id);
              } else {
                const { DISPUTE_KINDS, disputesFrom, paymentIsReversedByDisputes } =
                  await import("@/lib/disputes");
                const { data: ledger } = await (supabaseAdmin as any)
                  .from("review_items")
                  .select("kind, subject_id, detected_at, detail, dispute_ref")
                  .eq("organization_id", pay.organization_id)
                  .eq("subject_id", pay.id)
                  .in("kind", [...DISPUTE_KINDS, "payment_refunded"]);
                const rows = (ledger ?? []) as any[];
                const refunded = rows.some((r) => r.kind === "payment_refunded");
                const reversed =
                  refunded ||
                  paymentIsReversedByDisputes(
                    disputesFrom(
                      rows.map((r) => ({
                        paymentId: (r.subject_id as string | null) ?? null,
                        kind: r.kind as string,
                        day: String(r.detected_at ?? "").slice(0, 10),
                        amountCents: Number(r.detail?.amount_cents ?? 0),
                        disputeId: (r.dispute_ref as string | null) ?? "",
                      })),
                    ),
                  );
                const want = reversed ? "refunded" : "succeeded";
                // Only ever move BETWEEN those two. A payment sitting in any
                // other status was put there by something that is not a
                // dispute, and a dispute has no business overwriting it.
                if (
                  pay.status !== want &&
                  (pay.status === "refunded" || pay.status === "succeeded")
                ) {
                  await (supabaseAdmin as any)
                    .from("payments")
                    .update({ status: want })
                    .eq("id", pay.id);
                }
              }
            }
          } else if (event.type === "account.updated") {
            // Express onboarding progress: keep the org's charge-readiness fresh
            // so Settings → Payments flips to "Charges enabled" without a manual
            // refresh once Stripe finishes verifying the connected account.
            const acct = event.data.object as import("stripe").Stripe.Account;
            const { accountStateFrom } = await import("@/lib/stripe-connect.server");
            const { merchantRegionFrom } = await import("@/lib/processing-fee.server");
            const s = accountStateFrom(acct);
            // The merchant's state decides whether a card surcharge is lawful
            // (banned in CT, MA and PR) and lives nowhere else — `organizations`
            // has no address column. Synced here because this is the only event
            // that reports a connected account's details changing, and a
            // business that relocates must stop surcharging on the same day.
            const region = merchantRegionFrom(acct);
            await (supabaseAdmin as any)
              .from("organizations")
              .update({
                stripe_connect_charges_enabled: s.chargesEnabled,
                stripe_connect_status: s.status,
                // Only overwrite with a real answer: a partial account payload
                // that omits the address must not erase a known state, because
                // null suppresses the surcharge and would look like a bug.
                ...(region ? { stripe_merchant_region: region } : {}),
              })
              .eq("stripe_connect_account_id", acct.id);
          }
          // NOTE: customer.subscription.* is intentionally NOT handled here —
          // the org's own SaaS subscription (bucket A) is billed on the platform
          // account and reconciled by /api/public/hooks/platform-stripe. Handling
          // it here would let tenant-account events corrupt org billing state.
        } catch (e) {
          console.error("Webhook handler error", e);
          return new Response("Handler error", { status: 500 });
        }

        return new Response("ok", { status: 200 });
      },
    },
  },
});
