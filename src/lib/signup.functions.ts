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
import { serviceAreaSummary } from "@/lib/booking-page";
import {
  DEFAULT_BOOKING_DETAILS,
  bookingDetailsColumns,
  bookingDetailsSchema,
  bookingDetailsProblem,
  firstVisitOnOrAfter,
  normalizeBookingDetails,
  type BookingDetailsConfig,
} from "@/lib/booking-details";
import {
  isRequestedAsAStay,
  publicServiceChoices,
  type PublicService,
} from "@/lib/public-services";
import {
  customerCanBookService,
  serviceLinesOrDefault,
  type ServiceLineAvailability,
} from "@/lib/service-lines";
import {
  CALM_REFUSAL,
  ELAPSED_FIELD,
  HONEYPOT_FIELD,
  callerAddress,
  screenSubmission,
} from "@/lib/public-form-guard";

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
    // No business answers on this address: null, not an error, so the route
    // can tell "no such page" (a 404, #524) from "the lookup failed" (which
    // it leaves to the browser to ask again) without reading a message.
    if (!found) return null;

    // Read with the service role because the anon key cannot read
    // organizations, and only for the org the public lookup above resolved.
    // Nothing returned is private: name, branding, the form's own copy, and
    // the labels (never the prices) of the first-cleanup answers.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: org } = await (supabaseAdmin as any)
      .from("organizations")
      .select(
        "id, name, currency, logo_url, brand_color, portal_slug, slug, public_signup_enabled, lead_form_config, first_cleanup_pricing, contact_phone, contact_email, service_lines",
      )
      .eq("id", found.id)
      .maybeSingle();

    // Where the business works, for "Serving ZIP codes ..." under the
    // headline (#526): the ZIPs its zones list and nothing else of them, so
    // no price and no office label ("MAIN") leaves the server. A lookup that
    // fails hides the line; the page still loads.
    let serviceArea: string | null = null;
    try {
      const { data: zones, error: zonesErr } = await (supabaseAdmin as any)
        .from("zones")
        .select("zip_codes, postal_prefix")
        .eq("organization_id", found.id);
      if (zonesErr) console.error("signup service area lookup failed", found.id, zonesErr);
      else serviceArea = serviceAreaSummary(zones ?? []);
    } catch (e) {
      console.error("signup service area lookup failed", found.id, e);
    }

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

    // What the business sells, for the picker (phase 5, public paths). Through
    // public_services, the one door the publishable key has onto `services`:
    // it answers only for a business whose signup switch is on, with its
    // active, priced services and its zone-priced pet-waste one, so a
    // quote-only business and a business that sells one thing both get an
    // empty or one-row list and the form they always had. A lookup that
    // fails lists nothing, for the same reason: the page must still load.
    // Which lines are live is the platform switch, read at runtime (#531),
    // and handed to the form with the list so it filters by the same answer.
    let services: PublicService[] = [];
    let serviceLines: ServiceLineAvailability = { bookable: [], customerRequestable: [] };
    try {
      const { loadServiceLineAvailability } =
        await import("@/lib/service-line-availability.server");
      const [{ data: svcRows, error: svcErr }, availability] = await Promise.all([
        sb.rpc("public_services", { _slug: data.slug }),
        loadServiceLineAvailability(),
      ]);
      if (svcErr) console.error("signup services lookup failed", found.id, svcErr);
      else {
        serviceLines = availability;
        services = publicServiceChoices(svcRows, availability);
      }
    } catch (e) {
      console.error("signup services lookup failed", found.id, e);
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
      // How to reach the business, as the owner set it in Settings → Client
      // portal (the same two fields its customer email signs with). Each is
      // null when unset, and the page hides it.
      contact: {
        phone: ((org?.contact_phone as string | null) ?? "").trim() || null,
        email: ((org?.contact_email as string | null) ?? "").trim() || null,
      },
      // What the business runs (organizations.service_lines), so a page with
      // no service listed online speaks for that line rather than for pet
      // waste (#560). Not private: it is what the page sells.
      lines: serviceLinesOrDefault(org?.service_lines),
      serviceArea,
      services,
      serviceLines,
    };
  });

/** What a visitor reads when the service they named is not for sale online:
 *  another business's, a deactivated one, or one still Coming soon. */
const SERVICE_NOT_OFFERED_ONLINE = "That service isn't offered online right now. Pick another.";

/**
 * Refuses a service on a line that is still Coming soon (#506), before
 * public_quote is asked about it. The picker never lists one
 * (publicServiceChoices), so a request that names one anyway is a hand-built
 * body; it gets the words a refused service always got. Read with the service role, scoped to the
 * business the slug names. An id that is not that business's is left to
 * public_quote, which answers it with silence as before. public_quote also
 * ignores a Coming soon service itself (20261018150000); this says so in
 * words, and holds on a database that has not caught up.
 *
 * Returns the service it checked when it is this business's, so the caller
 * can ask the next question of it (refuseAStay) without a second lookup.
 */
async function refuseAComingSoonService(
  slug: string,
  serviceId: string | undefined,
): Promise<{ price_unit: unknown } | null> {
  if (!serviceId) return null;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: svc, error: svcErr } = await (supabaseAdmin as any)
    .from("services")
    .select("service_line, organization_id, price_unit")
    .eq("id", serviceId)
    .maybeSingle();
  if (svcErr) throw new Error(svcErr.message);
  if (!svc) return null;
  const { data: org, error: orgErr } = await (supabaseAdmin as any)
    .from("organizations")
    .select("slug, portal_slug")
    .eq("id", svc.organization_id)
    .maybeSingle();
  if (orgErr) throw new Error(orgErr.message);
  if (!org || (org.slug !== slug && org.portal_slug !== slug)) return null;
  const { loadServiceLineAvailability } = await import("@/lib/service-line-availability.server");
  if (!customerCanBookService(svc.service_line, await loadServiceLineAvailability())) {
    throw new Error(SERVICE_NOT_OFFERED_ONLINE);
  }
  return svc;
}

/** What a visitor reads when the service they named is a stay. */
export const A_STAY_IS_REQUESTED =
  "A stay is booked by request. Send your dates with Request this stay and we'll confirm it.";

/**
 * Refuses a stay (a service priced per night, #546) before public_quote is
 * asked about it: a stay is never priced as a cadence or started online. The
 * form never offers either for one (isRequestedAsAStay), so a request that
 * does is a hand-built body. Its path is the quote request, a lead.
 */
function refuseAStay(svc: { price_unit: unknown } | null) {
  if (isRequestedAsAStay(svc)) throw new Error(A_STAY_IS_REQUESTED);
}

const quoteSchema = z.object({
  slug: z.string().min(1).max(80),
  postal_code: z.string().trim().min(3).max(12),
  dog_count: z.coerce.number().int().min(1).max(20),
  frequency: z.enum(FREQS),
  // The customer's answer to "when was your yard last cleaned?", as the
  // owner's tier id. An id, never a price: public_quote prices it.
  last_cleaned: z.string().trim().max(40).optional().or(z.literal("")),
  // The service the visitor picked (phase 5), when the business offers more
  // than one. An id, never a price or a name: public_quote prices it, and
  // refuses another business's, a deactivated one, or one it cannot price.
  // Absent for a business that sells one thing, whose quote is the call it
  // always was.
  service_id: z.string().uuid().optional(),
});

/** The arguments public_quote takes from a quote request: only ever ids and
 *  answers, never a number of cents. Both callers below build them here. */
function publicQuoteArgs(data: z.infer<typeof quoteSchema>) {
  return {
    _slug: data.slug,
    _postal_code: data.postal_code.trim(),
    _dog_count: data.dog_count,
    _frequency: data.frequency,
    ...(data.last_cleaned ? { _last_cleaned: data.last_cleaned } : {}),
    ...(data.service_id ? { _service_id: data.service_id } : {}),
  };
}

export const getSignupQuote = createServerFn({ method: "POST" })
  .inputValidator((d) => quoteSchema.parse(d))
  .handler(async ({ data }) => {
    const named = await refuseAComingSoonService(data.slug, data.service_id);
    refuseAStay(named);
    const sb = anon();
    const { data: rows, error } = await sb.rpc("public_quote", publicQuoteArgs(data));
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
  // What the first visit needs (#527): the pets by name, how to get in, and
  // when to start. Never priced; the business's settings decide which are
  // asked and which are required (bookingDetailsProblem, below).
  ...bookingDetailsSchema.shape,
  // The spam filters, as the quote request sends them (public-form-guard.ts).
  [HONEYPOT_FIELD]: z.unknown().optional(),
  [ELAPSED_FIELD]: z.unknown().optional(),
});

/** The business's choices for the first-visit questions, read with the
 *  service role. A lookup that fails is the defaults (every question
 *  optional): an outage must not stop a sale, and optional asks nothing a
 *  visitor did not choose to give. */
async function loadBookingDetailsConfig(admin: any, orgId: string): Promise<BookingDetailsConfig> {
  try {
    const { data, error } = await admin
      .from("organizations")
      .select("lead_form_config")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw error;
    const cfg = data?.lead_form_config;
    return normalizeBookingDetails(cfg && typeof cfg === "object" ? (cfg as any).details : null);
  } catch (e) {
    console.error("booking details settings lookup failed", orgId, e);
    return DEFAULT_BOOKING_DETAILS;
  }
}

/** In-app signup prepay (Payment Element): records the signup request and
 * mints a PaymentIntent on the tenant's connected account. The prospect pays
 * without ever leaving the signup page; the webhook provisions the client on
 * payment_intent.succeeded (source "signup_inline"). Card only so payment
 * settles instantly and provisioning isn't delayed by ACH clearing. */
export const createSignupPaymentIntent = createServerFn({ method: "POST" })
  .inputValidator((d) => signupCheckoutSchema.parse(d))
  .handler(async ({ data }) => {
    // The spam filters, before anything is looked up or written. A signup
    // writes a lead and tells the office, exactly as a quote request does, so
    // it stands behind the same three (public-form-guard.ts); the rate limit
    // is below, once the business is known.
    const screened = screenSubmission({
      honeypot: data[HONEYPOT_FIELD],
      elapsedMs: data[ELAPSED_FIELD],
    });
    if (!screened.ok) {
      console.warn("public signup refused", screened.reason);
      throw new Error(CALM_REFUSAL);
    }

    // A Coming soon service takes no card and writes nothing (#506), and
    // neither does a stay (#546).
    const named = await refuseAComingSoonService(data.slug, data.service_id);
    refuseAStay(named);

    const sb = anon();
    const { data: qRows, error: qErr } = await sb.rpc("public_quote", publicQuoteArgs(data));
    if (qErr) throw new Error(qErr.message);
    const q = qRows?.[0];
    if (!q) {
      // public_quote answers nothing for a ZIP outside every zone, and the
      // same nothing for a service that is not this business's or is no
      // longer offered. With a service named, say the second.
      throw new Error(
        data.service_id
          ? SERVICE_NOT_OFFERED_ONLINE
          : "No service in that ZIP code yet. Try another.",
      );
    }
    // Everything charged below comes from `q`, which the database priced. See
    // signup-charge.ts: there is no path from the request body to an amount.
    const charge = signupChargeFromQuote(q);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // The first visit's answers, held to the business's own rules before
    // anything is written: a required question unanswered, or a start date
    // before the business can come, is said to the visitor in words.
    const detailsConfig = await loadBookingDetailsConfig(supabaseAdmin, q.organization_id);
    const detailsAnswer = {
      pets: data.pets,
      dogCount: data.dog_count,
      accessNotes: data.access_notes,
      preferredStartDate: data.preferred_start_date,
    };
    const detailsProblem = bookingDetailsProblem(
      detailsConfig,
      detailsAnswer,
      new Date().toISOString().slice(0, 10),
    );
    if (detailsProblem) throw new Error(detailsProblem);
    const details = bookingDetailsColumns(detailsConfig, detailsAnswer);

    // The chosen service's name, for the lead's notice and nothing else: the
    // price is already in `q`, and public_quote has just confirmed the id is
    // this business's. Best-effort, like every label.
    let serviceName: string | null = null;
    if (data.service_id) {
      try {
        const { data: svc } = await (supabaseAdmin as any)
          .from("services")
          .select("name")
          .eq("id", data.service_id)
          .eq("organization_id", q.organization_id)
          .maybeSingle();
        serviceName = (svc?.name as string | null) ?? null;
      } catch (e) {
        console.error("signup service name lookup failed", q.organization_id, e);
      }
    }

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

    // Per address and per business, before the lead, the signup request or
    // the PaymentIntent. A refused turn is not counted, so this writes
    // nothing either.
    {
      const { getRequestHeader } = await import("@tanstack/react-start/server");
      const { takePublicFormTurn } = await import("@/lib/public-form-guard.server");
      const turn = await takePublicFormTurn(
        supabaseAdmin as any,
        q.organization_id,
        callerAddress((h) => {
          try {
            return getRequestHeader(h as any);
          } catch {
            return null;
          }
        }),
      );
      if (!turn.ok) {
        console.warn("public signup rate-limited", q.organization_id, turn.reason);
        throw new Error(CALM_REFUSAL);
      }
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
      serviceId: data.service_id ?? null,
      serviceName,
      details,
    });

    const { data: sr, error: srErr } = await supabaseAdmin
      .from("signup_requests")
      .insert({
        lead_id: leadId,
        // The service signed up for (phase 5), only when one was picked: a
        // business that sells one thing writes the row it always wrote, and
        // the webhook gives its plan the business's default.
        ...(data.service_id ? { service_id: data.service_id } : {}),
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
        // What the webhook makes the first visit from (#527): dogs rows, the
        // property's access notes, and the subscription's start.
        ...details,
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
 * with no contacted or converted stamp, the only kind a public form writes.
 *
 * The office is told about the lead here, on the INSERT only
 * (lead-notify.server.ts). The re-use branch is the same household pressing
 * the button again, and the Stripe webhook that later marks this lead
 * converted is the same lead paying: neither is news, and neither notifies.
 * Exported for the test that holds it to that.
 */
export async function recordSignupLead(
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
    /** The service picked, when the business offers more than one (phase 5).
     *  Absent or null, the row has no service_id key at all. */
    serviceId?: string | null;
    serviceName?: string | null;
    /** The first visit's answers (#527), as bookingDetailsColumns stores
     *  them. Absent, the row has none of the three keys. */
    details?: ReturnType<typeof bookingDetailsColumns>;
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
      ...(lead.serviceId ? { service_id: lead.serviceId } : {}),
      ...(lead.details ?? {}),
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
    const id = (created?.id as string) ?? null;
    if (id) {
      const { notifyOfficeOfNewLead } = await import("@/lib/lead-notify.server");
      await notifyOfficeOfNewLead({
        orgId: lead.orgId,
        leadId: id,
        name: lead.name,
        source: lead.source,
        location: lead.location || null,
        dogCount: lead.dogCount,
        frequency: lead.frequency,
        serviceName: lead.serviceName ?? null,
      });
    }
    return id;
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
        "status, name, provisioned_client_id, refunded_at, refunded_amount_cents, currency, organization_id, preferred_start_date, created_at",
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
    const { data: org } = await (supabaseAdmin as any)
      .from("organizations")
      .select("name, logo_url, brand_color, contact_phone, contact_email, lead_form_config")
      .eq("id", row.organization_id)
      .maybeSingle();

    // When the first visit is (#527): the day asked for, else the earliest
    // the business allowed on the day of the signup. Said once the account
    // exists, with how to reach the business before then.
    const cfg = org?.lead_form_config;
    const startsOnOrAfter = firstVisitOnOrAfter(
      (row as any).preferred_start_date ?? null,
      String((row as any).created_at ?? new Date().toISOString()).slice(0, 10),
      normalizeBookingDetails(cfg && typeof cfg === "object" ? (cfg as any).details : null),
    );

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
      firstVisitOnOrAfter: startsOnOrAfter,
      contactPhone: ((org?.contact_phone as string | null) ?? "").trim() || null,
      contactEmail: ((org?.contact_email as string | null) ?? "").trim() || null,
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
      .select("name, slug, portal_slug, public_signup_enabled, contact_phone, contact_email")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    // What the booking page shows about the business (#526), read the way
    // getPublicSignupForm reads it, so Settings cannot promise a line the
    // page does not draw. Null when the zones lookup failed: "unknown".
    let serviceArea: string | null = null;
    let serviceAreaKnown = false;
    const { data: zones, error: zonesErr } = await (context.supabase as any)
      .from("zones")
      .select("zip_codes, postal_prefix")
      .eq("organization_id", orgId);
    if (zonesErr) console.error("signup settings zones lookup failed", orgId, zonesErr);
    else {
      serviceArea = serviceAreaSummary(zones ?? []);
      serviceAreaKnown = true;
    }
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
      bookingPage: {
        phone: ((org?.contact_phone as string | null) ?? "").trim() || null,
        email: ((org?.contact_email as string | null) ?? "").trim() || null,
        serviceArea,
        serviceAreaKnown,
      },
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
