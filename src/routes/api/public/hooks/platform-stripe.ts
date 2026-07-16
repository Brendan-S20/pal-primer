import { createFileRoute } from "@tanstack/react-router";

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
//   customer.created, customer.updated

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

        const Stripe = (await import("stripe")).default;
        const stripe = new Stripe(secret);
        let event: import("stripe").Stripe.Event;
        try {
          event = await stripe.webhooks.constructEventAsync(body, signature, webhookSecret);
        } catch (e) {
          console.error("Platform webhook signature failed", e);
          return new Response("Invalid signature", { status: 401 });
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Idempotency: skip if already recorded successfully
        const { data: existing } = await supabaseAdmin
          .from("platform_stripe_events")
          .select("id, processed_at")
          .eq("id", event.id)
          .maybeSingle();
        if (existing?.processed_at) return new Response("ok", { status: 200 });

        await supabaseAdmin
          .from("platform_stripe_events")
          .upsert({ id: event.id, type: event.type, payload: event as any, received_at: new Date().toISOString() });

        async function orgFromCustomer(customerId: string | null | undefined): Promise<string | null> {
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
              const customerId = typeof inv.customer === "string" ? inv.customer : inv.customer?.id ?? null;
              const orgId = await orgFromCustomer(customerId);
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
                  period_start: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
                  period_end: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
                  issued_at: inv.created ? new Date(inv.created * 1000).toISOString() : null,
                  due_at: inv.due_date ? new Date(inv.due_date * 1000).toISOString() : null,
                  paid_at: inv.status === "paid" && inv.status_transitions?.paid_at
                    ? new Date(inv.status_transitions.paid_at * 1000).toISOString()
                    : null,
                },
                { onConflict: "stripe_invoice_id" },
              );

              // Mirror plan status hints from invoice outcomes
              if (orgId) {
                if (event.type === "invoice.payment_failed") {
                  await supabaseAdmin.from("organizations").update({ plan_status: "past_due" }).eq("id", orgId);
                } else if (event.type === "invoice.paid") {
                  await supabaseAdmin.from("organizations").update({ plan_status: "active" }).eq("id", orgId);
                }
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
              const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer?.id ?? null;
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
                const currentPeriodEnd = (sub as any).current_period_end as number | undefined;
                const mapped = statusMap[sub.status] ?? "active";
                await supabaseAdmin
                  .from("organizations")
                  .update({
                    stripe_subscription_id: sub.id,
                    plan_status: mapped,
                    current_period_end: currentPeriodEnd
                      ? new Date(currentPeriodEnd * 1000).toISOString()
                      : null,
                  })
                  .eq("id", orgId);
                // A dead subscription takes its bolt-on add-ons with it: mark
                // them canceled and switch their feature flags off, so the org
                // doesn't keep paid features free (and can re-buy cleanly).
                if (event.type === "customer.subscription.deleted" || mapped === "canceled") {
                  try {
                    const { deactivateOrgPlatformAddons } = await import("@/lib/platform-addons.server");
                    await deactivateOrgPlatformAddons(orgId);
                  } catch (e) {
                    console.error("addon deactivation on subscription end failed", (e as Error).message);
                  }
                }
              }
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
