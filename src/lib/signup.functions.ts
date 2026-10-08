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
import { LEAD_SOURCE } from "@/lib/new-customer-form";

function anon() {
  return createClient<Database>(
    resolveSupabaseUrl(),
    process.env.SUPABASE_PUBLISHABLE_KEY!,
    { auth: { storage: undefined, persistSession: false, autoRefreshToken: false } },
  );
}

const FREQS = ["weekly", "biweekly", "twice_weekly", "monthly"] as const;

// The one public form's lookup: who the business is, how it looks, what its
// form asks, and whether this visitor can start service on the spot.
//
// It resolves through `public_get_org_for_lead_form`, NOT the signup lookup,
// and that is the point. `public_get_org_by_slug` and `public_quote` only
// answer for a business with public_signup_enabled, which is the right gate
// for taking a card and the wrong one for being reachable at all: an owner who
// only wants leads must still have a page. So the page always loads (for any
// business that has not been deleted), and `instantStart` says whether the
// price and the card are on offer. The price itself still comes only from
// `public_quote`, through getSignupQuote below, unchanged.
//
// This replaces getSignupOrg (the signup page's lookup) and getPublicLeadForm
// (the lead page's), which asked the same question of two different RPCs.
export const getPublicSignupForm = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().trim().min(1).max(120) }).parse(d))
  .handler(async ({ data }) => {
    const sb = anon();
    const { data: rows, error } = await sb.rpc("public_get_org_for_lead_form", { _slug: data.slug });
    if (error) throw new Error(error.message);
    const found = (rows as Array<{ id: string; name?: string }> | null)?.[0] ?? null;
    if (!found) throw new Error("This page isn't available.");

    // Read with the service role because the anon key cannot read
    // organizations, and only for the org the public lookup above resolved.
    // Nothing returned is private: name, branding, the form's own copy, and
    // the labels (never the prices) of the first-cleanup answers.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: org } = await (supabaseAdmin as any)
      .from("organizations")
      .select(
        "id, name, currency, logo_url, brand_color, portal_slug, slug, public_signup_enabled, lead_form_config, first_cleanup_pricing",
      )
      .eq("id", found.id)
      .maybeSingle();

    const { normalizeFormConfig } = await import("@/lib/new-customer-form");
    const form = normalizeFormConfig(org?.lead_form_config);

    let firstCleanup: { mode: string; tiers: Array<{ id: string; label: string }> } = {
      mode: "off",
      tiers: [],
    };
    try {
      const pricing = parseFirstCleanupPricing(org?.first_cleanup_pricing);
      firstCleanup = {
        mode: pricing.mode,
        tiers: pricing.tiers.map((t) => ({ id: t.id, label: t.label })),
      };
    } catch (e) {
      // Without it the page still quotes; the server refuses to charge a
      // tiered first cleanup nobody answered for, so this cannot under-bill.
      console.error("signup first-cleanup settings lookup failed", found.id, e);
    }

    // Whether "Start service" is on offer. The owner's switch first; then the
    // two things that would otherwise fail AFTER the visitor had typed
    // everything in and pressed the button: no Stripe account that can take
    // a charge (requireOrgStripeAccount throws at checkout), and a business
    // whose plan cannot take a client (the gate in createSignupPaymentIntent).
    // Either one now makes the page a quote request instead of a dead end.
    // A check that ERRORS is not a no, for the same reason as the gate below:
    // an outage in a lookup must not close every tenant's signup.
    const enabled = !!org?.public_signup_enabled;
    let instantStart = enabled;
    if (enabled) {
      try {
        const { resolveOrgStripeAccount } = await import("@/lib/stripe-connect.server");
        const acct = await resolveOrgStripeAccount(found.id);
        if (!acct || !acct.chargesEnabled) instantStart = false;
      } catch (e) {
        console.error("signup stripe readiness lookup failed", found.id, e);
      }
      if (instantStart) {
        const { data: mayTakeClient, error: mayErr } = await supabaseAdmin.rpc(
          "org_can_add_client",
          { _org_id: found.id },
        );
        if (mayErr) console.error("signup form entitlement lookup failed", found.id, mayErr);
        else if (mayTakeClient === false) instantStart = false;
      }
    }

    return {
      id: found.id as string,
      name: ((org?.name as string | null) ?? found.name ?? null) as string | null,
      currency: ((org?.currency as string | null) ?? "usd") as string,
      // The form's own brand colour and logo, when the owner set them on the
      // lead form, else the business's. Both settings existed; neither is lost.
      logoUrl: (form.logoUrl ?? (org?.logo_url as string | null) ?? null) as string | null,
      brandColor: (form.brandColor ?? (org?.brand_color as string | null) ?? null) as
        | string
        | null,
      resolvedSlug: ((org?.portal_slug as string | null) ?? (org?.slug as string | null) ?? data.slug) as string,
      instantStart,
      form,
      firstCleanup,
    };
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
  // Where the signup happened, for the label in Leads: the public page, or a
  // tech's phone handed over in walk mode. A label only; nothing is priced,
  // gated or trusted on it.
  channel: z.enum(["page", "door"]).optional(),
  // "Anything else?" from the form (a gate code, the dogs' names). There is
  // nowhere on a signup request for it, so it goes on the lead the signup
  // writes, where the office reads it beside the quote requests' notes.
  message: z.string().trim().max(2000).optional().or(z.literal("")),
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

    // Every signup is a lead too, so the office sees it in Leads beside the
    // quote requests: as "Started service online" once the card goes
    // through (the webhook marks it converted), and as "Started signup
    // online, didn't pay" if it never does, which is the person most worth a
    // call. Best-effort: a lead that fails to write must not stop a sale.
    const leadId = await recordSignupLead(supabaseAdmin, {
      orgId: q.organization_id,
      source: data.channel === "door" ? LEAD_SOURCE.doorSignup : LEAD_SOURCE.onlineSignup,
      name: data.name,
      email: data.email,
      phone: data.phone || null,
      location: [data.street, data.city, [data.region, data.postal_code.trim()].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", "),
      dogCount: data.dog_count,
      frequency: data.frequency,
      message: data.message || null,
    });

    const { data: sr, error: srErr } = await supabaseAdmin
      .from("signup_requests")
      .insert({
        lead_id: leadId,
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

/**
 * The lead a signup writes, or the one it already wrote. Pressing "Start
 * service", editing a field and pressing it again mints a fresh signup
 * request each time (the price has to be re-asked), and each one writing a
 * lead would put the same household in Leads three times. So a signup lead
 * from the same email at the same business in the last day, not yet worked,
 * is reused and brought up to date instead.
 *
 * Service role, because the visitor has no session; the row is a `new` lead
 * with no contacted or converted stamp, which is exactly what the public
 * INSERT policy allows an anonymous form to write anyway.
 */
async function recordSignupLead(
  admin: any,
  lead: {
    orgId: string;
    source: string;
    name: string;
    email: string;
    phone: string | null;
    location: string;
    dogCount: number;
    frequency: string;
    message: string | null;
  },
): Promise<string | null> {
  try {
    const email = lead.email.trim().toLowerCase();
    const fields = {
      name: lead.name,
      phone: lead.phone,
      location: lead.location || null,
      dog_count: lead.dogCount,
      frequency: lead.frequency,
      message: lead.message,
    };
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const { data: existing } = await admin
      .from("leads")
      .select("id")
      .eq("organization_id", lead.orgId)
      .eq("email", email)
      .eq("source", lead.source)
      .eq("status", "new")
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing?.id) {
      await admin.from("leads").update(fields).eq("id", existing.id);
      return existing.id as string;
    }
    const { data: created, error } = await admin
      .from("leads")
      .insert({ organization_id: lead.orgId, email, source: lead.source, status: "new", ...fields })
      .select("id")
      .single();
    if (error) throw error;
    return (created?.id as string) ?? null;
  } catch (e) {
    console.error("signup lead write failed", lead.orgId, e);
    return null;
  }
}

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
    // Whether a card can be taken, so the settings page can say why the form
    // is still a quote request with the switch on. Null when the lookup
    // failed: that is "unknown", not "no".
    let stripeReady: boolean | null = null;
    try {
      const { resolveOrgStripeAccount } = await import("@/lib/stripe-connect.server");
      const acct = await resolveOrgStripeAccount(orgId);
      stripeReady = !!acct?.chargesEnabled;
    } catch (e) {
      console.error("signup settings stripe lookup failed", orgId, e);
    }
    return {
      stripeReady,
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
