import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

function anon() {
  return createClient<Database>(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

const FREQS = ["weekly", "biweekly", "twice_weekly", "monthly"] as const;

export const getSignupOrg = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1).max(80) }).parse(d))
  .handler(async ({ data }) => {
    const sb = anon();
    const { data: rows, error } = await sb.rpc("public_get_org_by_slug", { _slug: data.slug });
    if (error) throw new Error(error.message);
    const org = rows?.[0];
    if (!org) throw new Error("Signup is not available for this URL.");
    return org;
  });

const quoteSchema = z.object({
  slug: z.string().min(1).max(80),
  postal_code: z.string().trim().min(3).max(12),
  dog_count: z.coerce.number().int().min(1).max(20),
  frequency: z.enum(FREQS),
});

export const getSignupQuote = createServerFn({ method: "POST" })
  .inputValidator((d) => quoteSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anon();
    const { data: rows, error } = await sb.rpc("public_quote", {
      _slug: data.slug,
      _postal_code: data.postal_code.trim(),
      _dog_count: data.dog_count,
      _frequency: data.frequency,
    });
    if (error) throw new Error(error.message);
    const q = rows?.[0];
    if (!q) return { available: false as const };
    return { available: true as const, quote: q };
  });

const checkoutSchema = quoteSchema.extend({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  region: z.string().trim().max(80).optional().or(z.literal("")),
  origin: z.string().url(),
});

export const createSignupCheckout = createServerFn({ method: "POST" })
  .inputValidator((d) => checkoutSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anon();
    const { data: qRows, error: qErr } = await sb.rpc("public_quote", {
      _slug: data.slug,
      _postal_code: data.postal_code.trim(),
      _dog_count: data.dog_count,
      _frequency: data.frequency,
    });
    if (qErr) throw new Error(qErr.message);
    const q = qRows?.[0];
    if (!q) throw new Error("No service in that ZIP code yet. Try another.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: sr, error: srErr } = await supabaseAdmin
      .from("signup_requests")
      .insert({
        organization_id: q.organization_id,
        zone_id: q.zone_id,
        name: data.name,
        email: data.email.toLowerCase(),
        phone: data.phone || null,
        street: data.street,
        city: data.city || null,
        region: data.region || null,
        postal_code: data.postal_code.trim(),
        dog_count: data.dog_count,
        frequency: data.frequency,
        recurring_price_cents: q.recurring_price_cents,
        initial_cleanup_cents: q.initial_cleanup_cents,
        currency: q.currency,
      })
      .select("id")
      .single();
    if (srErr) throw new Error(srErr.message);

    // Signup prepay charges the tenant's client → the tenant's connected account.
    const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(q.organization_id);
    const stripe = await connectStripe();

    const successUrl = `${data.origin}/signup/success?sr=${sr.id}`;
    const cancelUrl = `${data.origin}/signup/${encodeURIComponent(data.slug)}?canceled=1`;

    const initial = q.initial_cleanup_cents;
    const recurring = q.recurring_price_cents;

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: data.email.toLowerCase(),
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: q.currency,
            unit_amount: initial,
            product_data: { name: "First-time cleanup" },
          },
        },
        {
          quantity: 1,
          price_data: {
            currency: q.currency,
            unit_amount: recurring,
            product_data: {
              name: `Prepay first month (${data.frequency.replace("_", "-")})`,
              description: `${data.dog_count} dog${data.dog_count > 1 ? "s" : ""}`,
            },
          },
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        signup_request_id: sr.id,
        organization_id: q.organization_id,
      },
    }, { stripeAccount: acct.accountId });

    await supabaseAdmin
      .from("signup_requests")
      .update({ stripe_checkout_session_id: session.id })
      .eq("id", sr.id);

    return { url: session.url as string };
  });

export const getSignupStatus = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = anon();
    // Only expose safe non-PII status
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("signup_requests")
      .select("status, name, provisioned_client_id")
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    void sb;
    return row ?? null;
  });
