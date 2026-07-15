import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";

async function provisionSignup(
  supabaseAdmin: SupabaseClient,
  signupRequestId: string,
  session: import("stripe").Stripe.Checkout.Session,
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
    const prepay = (session.amount_total ?? 0) - (sr.initial_cleanup_cents ?? 0);
    if (prepay > 0) {
      await supabaseAdmin.from("credit_ledger").insert({
        organization_id: sr.organization_id,
        client_id: client.id,
        delta_cents: prepay,
        kind: "prepayment",
        note: `Signup prepay via Stripe ${session.id}`,
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
          portalUrl: await buildPortalLink(sr.organization_id, client.portal_token as string | null),
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
        // (Falls back to the legacy vars during the Connect cutover.)
        const secret = process.env.STRIPE_CONNECT_SECRET_KEY ?? process.env.STRIPE_SECRET_KEY;
        const webhookSecret = process.env.STRIPE_CONNECT_WEBHOOK_SECRET ?? process.env.STRIPE_WEBHOOK_SECRET;
        if (!secret || !webhookSecret) {
          return new Response("Stripe not configured", { status: 500 });
        }
        const signature = request.headers.get("stripe-signature");
        if (!signature) return new Response("Missing signature", { status: 400 });
        const body = await request.text();

        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(secret);
        let event: import("stripe").Stripe.Event;
        try {
          event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
        } catch (e) {
          console.error("Webhook signature verification failed", e);
          return new Response("Invalid signature", { status: 401 });
        }

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
              const setupIntentId = typeof session.setup_intent === "string"
                ? session.setup_intent
                : session.setup_intent?.id ?? null;
              // C1: the client must belong to the account that produced the event.
              const { data: setupClient } = clientId
                ? await supabaseAdmin.from("clients").select("organization_id").eq("id", clientId).maybeSingle()
                : { data: null };
              if (clientId && setupIntentId && await accountMatches((setupClient as any)?.organization_id)) {
                try {
                  // Connect: these objects live on the connected account.
                  const acctOpts = event.account ? { stripeAccount: event.account } : undefined;
                  const si = await stripe.setupIntents.retrieve(setupIntentId, undefined, acctOpts);
                  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
                  const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
                  if (pmId && customerId) {
                    const pm = await stripe.paymentMethods.retrieve(pmId, undefined, acctOpts);
                    await stripe.customers.update(customerId, {
                      invoice_settings: { default_payment_method: pmId },
                    }, acctOpts);
                    await supabaseAdmin.from("clients").update({
                      stripe_customer_id: customerId,
                      default_payment_method_id: pmId,
                      default_card_brand: pm.card?.brand ?? null,
                      default_card_last4: pm.card?.last4 ?? null,
                      // Only the client's own portal flow opts them into
                      // autopay; a staff-added card must not.
                      ...(session.metadata?.source === "portal_setup"
                        ? { autopay_enabled: true }
                        : {}),
                    }).eq("id", clientId);
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
                .from("signup_requests").select("organization_id").eq("id", signupRequestId).maybeSingle();
              if (await accountMatches((sr as any)?.organization_id)) {
                await provisionSignup(supabaseAdmin, signupRequestId, session);
              } else {
                console.error("signup webhook account mismatch", { signupRequestId, eventAccount: event.account });
              }
              return new Response("ok", { status: 200 });
            }

            const invoiceId = session.metadata?.invoice_id || session.client_reference_id;
            const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
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
              if (inv && inv.status !== "paid" && await accountMatches(inv.organization_id)) {
                const { markInvoicePaidFromStripe } = await import("@/lib/invoice-reconcile.server");
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
            const invoiceId = pi.metadata?.invoice_id;
            // Only handle PI-first flows (saved card, autopay, inline Payment
            // Element); Checkout flows are already finalized above via
            // checkout.session.completed and their PIs carry no invoice metadata.
            const source = pi.metadata?.source;
            if (invoiceId && (source === "portal_saved_card" || source === "autopay" || source === "portal_inline")) {
              const { data: inv } = await supabaseAdmin
                .from("invoices").select("id, organization_id, total_cents, currency, status, client_id")
                .eq("id", invoiceId).single();
              if (inv && inv.status !== "paid" && await accountMatches(inv.organization_id)) {
                const { markInvoicePaidFromStripe } = await import("@/lib/invoice-reconcile.server");
                const claimed = await markInvoicePaidFromStripe(supabaseAdmin, {
                  invoiceId: inv.id,
                  organizationId: inv.organization_id,
                  amountCents: pi.amount,
                  currency: pi.currency,
                  paymentIntentId: pi.id,
                  raw: event,
                });
                // Successful autopay clears the dunning failure ladder.
                if (claimed) {
                  await supabaseAdmin.from("clients").update({
                    autopay_failure_count: 0,
                    autopay_paused: false,
                    autopay_last_error: null,
                    autopay_last_attempt_at: new Date().toISOString(),
                  }).eq("id", inv.client_id);
                }
              }
            }
          } else if (event.type === "payment_intent.payment_failed") {
            const pi = event.data.object as import("stripe").Stripe.PaymentIntent;
            const invoiceId = pi.metadata?.invoice_id;
            if (invoiceId) {
              // C1: ignore unless the invoice belongs to the event's account.
              const { data: invOwner } = await supabaseAdmin
                .from("invoices").select("organization_id").eq("id", invoiceId).maybeSingle();
              if (!(await accountMatches((invOwner as any)?.organization_id))) {
                console.error("payment_failed webhook account mismatch", { invoiceId, eventAccount: event.account });
                return new Response("ok", { status: 200 });
              }
              await supabaseAdmin.from("payments").insert({
                organization_id: (invOwner as any).organization_id,
                invoice_id: invoiceId,
                amount_cents: pi.amount,
                currency: pi.currency,
                status: "failed",
                stripe_payment_intent_id: pi.id,
                raw_event: JSON.parse(JSON.stringify(event)),
              });
              // Record error on client for autopay visibility
              const err = pi.last_payment_error?.message ?? "Card charge failed";
              const { data: inv } = await supabaseAdmin
                .from("invoices").select("client_id, organization_id").eq("id", invoiceId).single();
              if (inv?.client_id) {
                // Dunning: increment failure count, pause autopay if past org threshold.
                const [{ data: c }, { data: orgCfg }] = await Promise.all([
                  supabaseAdmin.from("clients")
                    .select("autopay_failure_count").eq("id", inv.client_id).single(),
                  supabaseAdmin.from("organizations")
                    .select("dunning_pause_after_failures").eq("id", inv.organization_id).single(),
                ]);
                const nextCount = (c?.autopay_failure_count ?? 0) + 1;
                const threshold = orgCfg?.dunning_pause_after_failures ?? 3;
                await supabaseAdmin.from("clients").update({
                  autopay_last_error: err,
                  autopay_last_attempt_at: new Date().toISOString(),
                  autopay_failure_count: nextCount,
                  autopay_paused: nextCount >= threshold,
                }).eq("id", inv.client_id);

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
                      .select("display_name, primary_phone, sms_opt_out, portal_token")
                      .eq("id", inv.client_id).single();
                    if (c && !c.sms_opt_out && c.primary_phone) {
                      const { sendTwilioSms } = await import("@/lib/twilio.server");
                      const { buildPortalLink } = await import("@/lib/portal-links.server");
                      const url = await buildPortalLink(inv.organization_id, c.portal_token as string | null);
                      const body = `Hi ${c.display_name}, your card on file was declined. Please update your payment method: ${url}`;
                      const r = await sendTwilioSms({ from: dunningFrom, to: c.primary_phone, body });
                      await supabaseAdmin.from("messages").insert({
                        organization_id: inv.organization_id,
                        client_id: inv.client_id,
                        direction: "outbound",
                        body,
                        from_number: dunningFrom,
                        to_number: c.primary_phone,
                        twilio_sid: r.sid,
                        status: (r.status as "queued" | "sent" | "delivered" | "failed" | "received" | undefined) ?? "queued",
                      });
                    }
                  }
                } catch (e) { console.error("payment-failed SMS failed", e); }

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
                } catch (e) { console.error("payment-failed in-app notification failed", e); }
              }
            }

          } else if (event.type === "account.updated") {
            // Express onboarding progress: keep the org's charge-readiness fresh
            // so Settings → Payments flips to "Charges enabled" without a manual
            // refresh once Stripe finishes verifying the connected account.
            const acct = event.data.object as import("stripe").Stripe.Account;
            const { accountStateFrom } = await import("@/lib/stripe-connect.server");
            const s = accountStateFrom(acct);
            await (supabaseAdmin as any).from("organizations").update({
              stripe_connect_charges_enabled: s.chargesEnabled,
              stripe_connect_status: s.status,
            }).eq("stripe_connect_account_id", acct.id);
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
