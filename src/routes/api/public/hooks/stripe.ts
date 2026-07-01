import { createFileRoute } from "@tanstack/react-router";

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
