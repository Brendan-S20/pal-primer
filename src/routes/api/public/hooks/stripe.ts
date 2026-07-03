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
      const appUrl = process.env.APP_URL || "https://pal-primer.lovable.app";
      const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
      await enqueueAppEmail({
        organizationId: sr.organization_id,
        clientId: client.id,
        templateName: "welcome",
        notifyKey: "notify_email_welcome",
        idempotencyKey: `welcome-signup-${signupRequestId}`,
        templateData: {
          portalUrl: client.portal_token ? `${appUrl}/portal/${client.portal_token}` : undefined,
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
        const secret = process.env.STRIPE_SECRET_KEY;
        const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
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

        try {
          if (event.type === "checkout.session.completed") {
            const session = event.data.object as import("stripe").Stripe.Checkout.Session;

            // Portal saved-card setup flow
            if (session.mode === "setup" && session.metadata?.source === "portal_setup") {
              const clientId = session.metadata.client_id;
              const setupIntentId = typeof session.setup_intent === "string"
                ? session.setup_intent
                : session.setup_intent?.id ?? null;
              if (clientId && setupIntentId) {
                try {
                  const si = await stripe.setupIntents.retrieve(setupIntentId);
                  const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
                  const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
                  if (pmId && customerId) {
                    const pm = await stripe.paymentMethods.retrieve(pmId);
                    await stripe.customers.update(customerId, {
                      invoice_settings: { default_payment_method: pmId },
                    });
                    await supabaseAdmin.from("clients").update({
                      stripe_customer_id: customerId,
                      default_payment_method_id: pmId,
                      default_card_brand: pm.card?.brand ?? null,
                      default_card_last4: pm.card?.last4 ?? null,
                      autopay_enabled: true,
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
              await provisionSignup(supabaseAdmin, signupRequestId, session);
              return new Response("ok", { status: 200 });
            }

            const invoiceId = session.metadata?.invoice_id || session.client_reference_id;
            const pi = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id ?? null;
            if (invoiceId) {
              const { data: inv } = await supabaseAdmin
                .from("invoices")
                .select("id, organization_id, total_cents, currency")
                .eq("id", invoiceId)
                .single();
              if (inv) {
                await supabaseAdmin.from("invoices").update({
                  status: "paid",
                  paid_at: new Date().toISOString(),
                  stripe_payment_intent_id: pi,
                }).eq("id", invoiceId);
                await supabaseAdmin.from("payments").insert({
                  organization_id: inv.organization_id,
                  invoice_id: inv.id,
                  amount_cents: session.amount_total ?? inv.total_cents,
                  currency: session.currency ?? inv.currency,
                  status: "succeeded",
                  stripe_checkout_session_id: session.id,
                  stripe_payment_intent_id: pi,
                  paid_at: new Date().toISOString(),
                  raw_event: JSON.parse(JSON.stringify(event)),
                });

                // Fire payment-received receipt (best-effort)
                try {
                  const { data: fullInv } = await supabaseAdmin
                    .from("invoices")
                    .select("client_id")
                    .eq("id", invoiceId)
                    .single();
                  if (fullInv) {
                    const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
                    await enqueueAppEmail({
                      organizationId: inv.organization_id,
                      clientId: fullInv.client_id,
                      templateName: "payment-received",
                      notifyKey: "notify_email_payment_received",
                      idempotencyKey: `receipt-${invoiceId}`,
                      templateData: {
                        amountCents: session.amount_total ?? inv.total_cents,
                        paidAt: new Date().toLocaleDateString("en-US", {
                          month: "short", day: "numeric", year: "numeric",
                        }),
                      },
                    });
                  }
                } catch (e) {
                  console.error("receipt email failed", e);
                }
              }
            }
          } else if (event.type === "payment_intent.succeeded") {
            const pi = event.data.object as import("stripe").Stripe.PaymentIntent;
            const invoiceId = pi.metadata?.invoice_id;
            // Only handle off-session/portal-saved-card flows; Checkout flows
            // are already finalized above via checkout.session.completed.
            const source = pi.metadata?.source;
            if (invoiceId && (source === "portal_saved_card" || source === "autopay")) {
              const { data: inv } = await supabaseAdmin
                .from("invoices").select("id, organization_id, total_cents, currency, status, client_id")
                .eq("id", invoiceId).single();
              if (inv && inv.status !== "paid") {
                await supabaseAdmin.from("invoices").update({
                  status: "paid",
                  paid_at: new Date().toISOString(),
                  stripe_payment_intent_id: pi.id,
                }).eq("id", invoiceId);
                await supabaseAdmin.from("payments").insert({
                  organization_id: inv.organization_id,
                  invoice_id: inv.id,
                  amount_cents: pi.amount,
                  currency: pi.currency,
                  status: "succeeded",
                  stripe_payment_intent_id: pi.id,
                  paid_at: new Date().toISOString(),
                  raw_event: JSON.parse(JSON.stringify(event)),
                });
                try {
                  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
                  await enqueueAppEmail({
                    organizationId: inv.organization_id,
                    clientId: inv.client_id,
                    templateName: "payment-received",
                    notifyKey: "notify_email_payment_received",
                    idempotencyKey: `receipt-${invoiceId}`,
                    templateData: {
                      amountCents: pi.amount,
                      paidAt: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }),
                    },
                  });
                } catch (e) { console.error("receipt email failed", e); }
              }
            }
          } else if (event.type === "payment_intent.payment_failed") {
            const pi = event.data.object as import("stripe").Stripe.PaymentIntent;
            const invoiceId = pi.metadata?.invoice_id;
            if (invoiceId) {
              await supabaseAdmin.from("payments").insert({
                organization_id: pi.metadata?.organization_id ?? "00000000-0000-0000-0000-000000000000",
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
                await supabaseAdmin.from("clients").update({
                  autopay_last_error: err,
                  autopay_last_attempt_at: new Date().toISOString(),
                }).eq("id", inv.client_id);

                // Optional SMS alert to client (org toggle)
                try {
                  const { data: org } = await supabaseAdmin
                    .from("organizations")
                    .select("sms_from_number, notify_sms_payment_failed")
                    .eq("id", inv.organization_id)
                    .single();
                  if (org?.notify_sms_payment_failed && org.sms_from_number) {
                    const { data: c } = await supabaseAdmin
                      .from("clients")
                      .select("display_name, primary_phone, sms_opt_out, portal_token")
                      .eq("id", inv.client_id).single();
                    if (c && !c.sms_opt_out && c.primary_phone) {
                      const { sendTwilioSms } = await import("@/lib/twilio.server");
                      const url = `${process.env.APP_URL || "https://pal-primer.lovable.app"}/portal/${c.portal_token}`;
                      const body = `Hi ${c.display_name}, your card on file was declined. Please update your payment method: ${url}`;
                      const r = await sendTwilioSms({ from: org.sms_from_number, to: c.primary_phone, body });
                      await supabaseAdmin.from("messages").insert({
                        organization_id: inv.organization_id,
                        client_id: inv.client_id,
                        direction: "outbound",
                        body,
                        from_number: org.sms_from_number,
                        to_number: c.primary_phone,
                        twilio_sid: r.sid,
                        status: r.status,
                      });
                    }
                  }
                } catch (e) { console.error("payment-failed SMS failed", e); }
              }
            }

          } else if (
            event.type === "customer.subscription.created" ||
            event.type === "customer.subscription.updated" ||
            event.type === "customer.subscription.deleted"
          ) {
            const sub = event.data.object as import("stripe").Stripe.Subscription;
            const orgId = sub.metadata?.organization_id;
            const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
            const periodEnd = (sub as unknown as { current_period_end?: number }).current_period_end;
            let planStatus: "active" | "past_due" | "canceled" = "canceled";
            if (event.type !== "customer.subscription.deleted") {
              if (["active", "trialing"].includes(sub.status)) planStatus = "active";
              else if (sub.status === "past_due") planStatus = "past_due";
              else if (["canceled", "incomplete_expired", "unpaid"].includes(sub.status)) planStatus = "canceled";
              else planStatus = "canceled";
            }
            // Locate org by metadata, else by customer id
            let targetOrgId: string | null = orgId ?? null;
            if (!targetOrgId && customerId) {
              const { data: found } = await supabaseAdmin
                .from("organizations")
                .select("id")
                .eq("stripe_customer_id", customerId)
                .maybeSingle();
              targetOrgId = (found?.id as string | undefined) ?? null;
            }

            if (targetOrgId) {
              await supabaseAdmin.from("organizations").update({
                plan_status: planStatus,
                stripe_subscription_id: event.type === "customer.subscription.deleted" ? null : sub.id,
                current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString() : null,
                ...(customerId ? { stripe_customer_id: customerId } : {}),
              }).eq("id", targetOrgId);
            }
          }

        } catch (e) {
          console.error("Webhook handler error", e);
          return new Response("Handler error", { status: 500 });
        }

        return new Response("ok", { status: 200 });
      },
    },
  },
});
