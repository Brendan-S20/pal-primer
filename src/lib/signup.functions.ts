import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { platformFeeCents } from "@/lib/platform-fee";
import { resolveSupabaseUrl } from "@/lib/supabase-url";
import { parseFirstCleanupPricing } from "@/lib/first-cleanup";
import { parseQuoteOptions, signupChargeFromQuote } from "@/lib/signup-charge";

function anon() {
  return createClient<Database>(
    resolveSupabaseUrl(),
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

    // Whether to ask "when was your yard last cleaned?", and with which
    // answers. Labels and ids only: a price depends on the zone and the dogs,
    // so it comes back with the quote, priced by the database. Read with the
    // service role because the anon key cannot read organizations, and only
    // for the org the public lookup above already resolved.
    let firstCleanup: { mode: string; tiers: Array<{ id: string; label: string }> } = {
      mode: "off",
      tiers: [],
    };
    try {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: cfg } = await (supabaseAdmin as any)
        .from("organizations")
        .select("first_cleanup_pricing")
        .eq("id", org.id)
        .maybeSingle();
      const pricing = parseFirstCleanupPricing(cfg?.first_cleanup_pricing);
      firstCleanup = {
        mode: pricing.mode,
        tiers: pricing.tiers.map((t) => ({ id: t.id, label: t.label })),
      };
    } catch (e) {
      // Without it the page still quotes; the server refuses to charge a
      // tiered first cleanup nobody answered for, so this cannot under-bill.
      console.error("signup first-cleanup settings lookup failed", org.id, e);
    }
    return { ...org, firstCleanup };
  });

const quoteSchema = z.object({
  slug: z.string().min(1).max(80),
  postal_code: z.string().trim().min(3).max(12),
  dog_count: z.coerce.number().int().min(1).max(20),
  frequency: z.enum(FREQS),
  // The customer's answer to "when was your yard last cleaned?", as the
  // owner's tier id. An id, never a price: public_quote prices it.
  last_cleaned: z.string().trim().max(40).optional().or(z.literal("")),
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
      ...(data.last_cleaned ? { _last_cleaned: data.last_cleaned } : {}),
    });
    if (error) throw new Error(error.message);
    const q = rows?.[0];
    if (!q) return { available: false as const };
    return {
      available: true as const,
      quote: { ...q, first_cleanup_options: parseQuoteOptions(q.first_cleanup_options) },
    };
  });

/** Exported for the test that proves a price in the request body is dropped
 *  before the handler runs. zod strips keys a schema does not name. */
export const signupCheckoutSchema = quoteSchema.extend({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(255),
  phone: z.string().trim().max(40).optional().or(z.literal("")),
  street: z.string().trim().min(1).max(200),
  city: z.string().trim().max(120).optional().or(z.literal("")),
  region: z.string().trim().max(80).optional().or(z.literal("")),
});

/** In-app signup prepay (Payment Element): records the signup request and
 * mints a PaymentIntent on the tenant's connected account. The prospect pays
 * without ever leaving the signup page; the webhook provisions the client on
 * payment_intent.succeeded (source "signup_inline"). Card only so payment
 * settles instantly and provisioning isn't delayed by ACH clearing. */
export const createSignupPaymentIntent = createServerFn({ method: "POST" })
  .inputValidator((d) => signupCheckoutSchema.parse(d))
  .handler(async ({ data }) => {
    const sb = anon();
    const { data: qRows, error: qErr } = await sb.rpc("public_quote", {
      _slug: data.slug,
      _postal_code: data.postal_code.trim(),
      _dog_count: data.dog_count,
      _frequency: data.frequency,
      ...(data.last_cleaned ? { _last_cleaned: data.last_cleaned } : {}),
    });
    if (qErr) throw new Error(qErr.message);
    const q = qRows?.[0];
    if (!q) throw new Error("No service in that ZIP code yet. Try another.");
    // Everything charged below comes from `q`, which the database priced. See
    // signup-charge.ts: there is no path from the request body to an amount.
    const charge = signupChargeFromQuote(q);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // The entitlement gate, BEFORE any money moves.
    //
    // `org_can_add_client` is enforced by `tg_clients_enforce_plan_limit`, a
    // trigger on `clients`, so a tenant whose plan is canceled or whose trial
    // has run out cannot have a client row inserted. That trigger fires inside
    // `provisionSignup`, which runs in the Stripe webhook — i.e. AFTER the
    // prospect's card has been charged. Without this check the failure mode is
    // a homeowner who has paid for a first cleanup and a first visit at a
    // business that is not allowed to take them on, learning it from an
    // apologetic page and a support email. The webhook now refunds that
    // charge, but a refund the customer has to notice and wait out is a worse
    // outcome than never taking the card, and it costs the tenant the Stripe
    // fee either way.
    //
    // What it actually checks, read from the live definition rather than
    // assumed: plan_status in (active, past_due, free), an unexpired trial, or
    // an admin-granted grace window. Despite the trigger's name there is no
    // client-count or seat cap in it today, so this gate is "is this tenant's
    // subscription alive", not "do they have room". If a real limit is added
    // later this call picks it up with no change here, which is the reason to
    // call the same function the trigger calls instead of re-deriving the rule.
    //
    // Read with the service-role client on purpose: the function RAISEs for a
    // signed-in caller who is not a member of `_org_id`, and a prospect is not
    // a member of anything. Under service_role `auth.uid()` is NULL, that
    // guard is skipped, and the plan check is all that runs.
    //
    // A gate that errors is not a gate that says no — an outage in this RPC
    // must not close every tenant's signup page, so only an explicit `false`
    // stops the flow.
    const { data: canAdd, error: gateErr } = await supabaseAdmin.rpc("org_can_add_client", {
      _org_id: q.organization_id,
    });
    if (gateErr) {
      console.error("signup entitlement check failed", q.organization_id, gateErr);
    } else if (canAdd === false) {
      // Said to a member of the public, so it names no plan state and blames
      // nobody: the prospect cannot act on "this business's subscription has
      // lapsed" and the tenant would rather not have it announced to the
      // people they are trying to sell to.
      throw new Error(
        "This business isn't accepting new online signups right now. Please contact them directly and they'll get you set up.",
      );
    }

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
        recurring_price_cents: charge.recurringCents,
        initial_cleanup_cents: charge.firstCleanupCents,
        first_cleanup_tier_id: charge.firstCleanupLabel ? data.last_cleaned || null : null,
        first_cleanup_label: charge.firstCleanupLabel,
        currency: q.currency,
      })
      .select("id")
      .single();
    if (srErr) throw new Error(srErr.message);

    // Signup prepay charges the tenant's client → the tenant's connected account.
    const { requireOrgStripeAccount, connectStripe, connectPublishableKey } = await import(
      "@/lib/stripe-connect.server"
    );
    const acct = await requireOrgStripeAccount(q.organization_id);
    const stripe = await connectStripe();

    const amountCents = charge.amountCents;
    const pi = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        application_fee_amount: platformFeeCents(amountCents),
        currency: q.currency,
        receipt_email: data.email.toLowerCase(),
        payment_method_types: ["card"],
        // "first visit", not "first month": the recurring price is PER VISIT
        // (see the note in SignupFlow.tsx), and the credit this funds pays
        // for exactly one.
        description: `${charge.firstCleanupCents > 0 ? "First cleanup + first visit" : "First visit"} prepay (${data.frequency.replace("_", "-")}, ${data.dog_count} dog${data.dog_count > 1 ? "s" : ""})`,
        metadata: {
          signup_request_id: sr.id,
          organization_id: q.organization_id,
          source: "signup_inline",
        },
      },
      { stripeAccount: acct.accountId },
    );

    await supabaseAdmin
      .from("signup_requests")
      .update({ stripe_payment_intent_id: pi.id })
      .eq("id", sr.id);

    return {
      clientSecret: pi.client_secret as string,
      publishableKey: connectPublishableKey(),
      stripeAccount: acct.accountId,
      amountCents,
      currency: q.currency as string,
      signupRequestId: sr.id as string,
    };
  });

export const getSignupStatus = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const sb = anon();
    // Only expose safe non-PII status
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: row, error } = await supabaseAdmin
      .from("signup_requests")
      .select(
        "status, name, provisioned_client_id, refunded_at, refunded_amount_cents, currency, organization_id",
      )
      .eq("id", data.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    void sb;
    if (!row) return null;

    // The success page has to apologise accurately when provisioning failed,
    // and "we have refunded you" is only sayable if the refund actually
    // happened. `error_message` is deliberately NOT returned — it carries
    // Postgres constraint text written for us, not for a homeowner.
    const { data: org } = await supabaseAdmin
      .from("organizations")
      .select("name, logo_url, brand_color")
      .eq("id", row.organization_id)
      .maybeSingle();

    return {
      status: row.status,
      name: row.name,
      provisioned_client_id: row.provisioned_client_id,
      refunded: !!row.refunded_at,
      refundedAmountCents: row.refunded_amount_cents ?? null,
      currency: row.currency,
      orgName: (org?.name as string | null) ?? null,
      logoUrl: (org?.logo_url as string | null) ?? null,
      brandColor: (org?.brand_color as string | null) ?? null,
    };
  });

// ── The settings surface for the two gates ─────────────────────────────────
//
// Until now nothing in the product wrote either one. `public_signup_enabled`
// defaults to false and had no toggle anywhere; `organizations.slug` is only
// ever NULL on a tenant that signed itself up, because `bootstrap_organization`
// does not set it. So the whole /signup/{slug} flow — quote, card form, webhook
// provisioning, welcome email — was code nobody could reach, and no owner could
// have found that out from the app.
//
// The slug edited here is `organizations.slug`, the signup-specific address.
// Leaving it empty is a supported answer: since 20260809001000 the lookup also
// resolves `portal_slug`, so a tenant who has set their portal address already
// has a working signup link and does not need a second one.

export const getSignupSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { data: org, error } = await context.supabase
      .from("organizations")
      .select("name, slug, portal_slug, public_signup_enabled")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      orgName: (org?.name as string | null) ?? null,
      signupSlug: (org?.slug as string | null) ?? null,
      portalSlug: (org?.portal_slug as string | null) ?? null,
      // What /signup/{…} actually answers on today. The RPC prefers
      // portal_slug, so a tenant with both set is reachable at both, and this
      // reports the one their own links should use.
      effectiveSlug: (org?.portal_slug as string | null) ?? (org?.slug as string | null) ?? null,
      publicSignupEnabled: !!org?.public_signup_enabled,
    };
  });

const signupSettingsSchema = z.object({
  // Optional so the toggle and the address can be saved independently; a field
  // that is absent is left alone rather than blanked.
  publicSignupEnabled: z.boolean().optional(),
  // "" clears it — the tenant is choosing to be addressed by their portal slug.
  signupSlug: z.string().trim().max(63).optional(),
});

export const setSignupSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => signupSettingsSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const patch: Record<string, unknown> = {};

    if (data.publicSignupEnabled !== undefined) {
      patch.public_signup_enabled = data.publicSignupEnabled;
    }

    if (data.signupSlug !== undefined) {
      const { slugify, isUuid } = await import("@/lib/portal-links.server");
      const clean = data.signupSlug ? slugify(data.signupSlug) : "";
      if (clean && clean.length < 3) throw new Error("Use at least 3 letters or numbers.");
      if (isUuid(clean)) throw new Error("That format isn't allowed.");

      if (clean) {
        // `organizations.slug` carries a UNIQUE constraint, so a collision
        // would come back as a raw 23505 with the constraint name in it. Check
        // first and say something an owner can act on. `portal_slug` is checked
        // too even though it is not unique in the database: since
        // 20260809001000 both columns answer at /signup/{…}, so taking another
        // tenant's portal address would make which business a prospect reaches
        // depend on the RPC's tie-break.
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { data: taken } = await supabaseAdmin
          .from("organizations")
          .select("id")
          .or(`slug.eq.${clean},portal_slug.eq.${clean}`)
          .neq("id", orgId)
          .limit(1)
          .maybeSingle();
        if (taken) throw new Error("That address is already taken. Try another.");
      }

      patch.slug = clean || null;
    }

    if (Object.keys(patch).length === 0) return { ok: true as const };

    // Through the helper, never a bare .update(): an UPDATE that matches zero
    // rows under RLS returns no error, so the toggle would show a success toast
    // and be back off on reload — which is exactly the class of bug
    // org-write.server.ts exists to make impossible. See its header.
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, patch);
    return { ok: true as const };
  });
