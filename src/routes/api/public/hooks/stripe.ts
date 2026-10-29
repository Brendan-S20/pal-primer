import { createFileRoute } from "@tanstack/react-router";
import type { SupabaseClient } from "@supabase/supabase-js";
import { feeReversalCents } from "@/lib/platform-fee";
import { makeStripe, warnOnApiVersionMismatch } from "@/lib/stripe-client.server";
import { bookedGroomPhrase, onlineGroomBookingFrom } from "@/lib/groom-online";
import {
  cleanPets,
  firstVisitOnOrAfter,
  formatStartDate,
  normalizeBookingDetails,
  type PetEntry,
} from "@/lib/booking-details";
import {
  isoWeekday,
  nextIsoDay,
  packageSessionEnd,
  signupBookingMode,
} from "@/lib/public-booking-mode";

/** The service's name, for the invoice line. Best-effort, like every label. */
async function signupServiceName(
  supabaseAdmin: SupabaseClient,
  sr: { service_id?: string | null; organization_id: string },
): Promise<string | null> {
  if (!sr.service_id) return null;
  try {
    const { data } = await supabaseAdmin
      .from("services")
      .select("name")
      .eq("id", sr.service_id)
      .eq("organization_id", sr.organization_id)
      .maybeSingle();
    return ((data as { name?: string } | null)?.name ?? null) as string | null;
  } catch {
    return null;
  }
}

async function provisionSignup(
  supabaseAdmin: SupabaseClient,
  signupRequestId: string,
  // Works for both flows: legacy hosted Checkout (session id) and the
  // in-app Payment Element (payment intent id).
  //
  // `paymentIntentId` is separate from `stripeRef` because the refund below
  // needs the intent specifically: on the Checkout path `stripeRef` is a
  // session id, which `refunds.create` will not accept.
  paid: { amountTotalCents: number; stripeRef: string; paymentIntentId: string | null },
  // The connected account the charge lives on, and a Stripe client that can
  // reach it. Direct charges settle into the tenant's balance, so a refund has
  // to be issued against THEIR account or it finds nothing.
  refundVia: { stripe: import("stripe").Stripe; stripeAccount: string | null },
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
  // Already refunded on an earlier attempt: the prospect's money is back, so
  // there is nothing left that this signup has paid for. Provisioning it now
  // on a webhook redelivery would hand out a service nobody is paying for and
  // send a welcome email to someone who has been told the sale did not happen.
  if (sr.refunded_at) {
    console.warn("provisionSignup: already refunded, not retrying", signupRequestId);
    return;
  }

  try {
    // The customer this signup belongs to — reused, not duplicated.
    //
    // This used to be a blind INSERT. A homeowner who signs up twice (a second
    // property, a browser back-button, a card that failed and was retried
    // through a fresh request) got a SECOND client row with the same email, a
    // second portal_token and therefore a second portal account. The office
    // then sees two customers and bills them separately, and the homeowner has
    // two welcome emails with two links, only one of which shows the service
    // they just bought. There is no unique constraint on (organization_id,
    // primary_email) to lean on, so the dedupe happens here.
    //
    // The ilike is a PRE-FILTER, not the comparison: PostgREST passes the
    // pattern through to LIKE, where `_` and `%` are wildcards and both are
    // legal in an email local-part, so `a_b@x.com` would also match
    // `axb@x.com`. Wildcards can only over-match, never under-match, so every
    // candidate is re-checked in JS on lowercased equality — which is what
    // "(organization_id, lower(primary_email))" actually means.
    const email = (sr.email as string).trim().toLowerCase();
    const { data: candidates } = await supabaseAdmin
      .from("clients")
      .select("id, portal_token, primary_email")
      .eq("organization_id", sr.organization_id)
      .ilike("primary_email", email);
    const existing =
      (candidates ?? []).find(
        (c: { primary_email: string | null }) =>
          (c.primary_email ?? "").trim().toLowerCase() === email,
      ) ?? null;

    let client: { id: string; portal_token: string | null };
    if (existing) {
      // Attach to the account they already have. Deliberately no UPDATE of
      // display_name or phone: the office may have corrected those, and a
      // signup form is not a more authoritative source than the record the
      // business has been maintaining.
      client = { id: existing.id, portal_token: existing.portal_token };
      console.warn("provisionSignup: attaching to existing client", {
        signupRequestId,
        clientId: existing.id,
      });
    } else {
      const { data: created, error: cErr } = await supabaseAdmin
        .from("clients")
        .insert({
          organization_id: sr.organization_id,
          display_name: sr.name,
          account_type: "residential",
          primary_email: email,
          primary_phone: sr.phone,
        })
        .select("id, portal_token")
        .single();
      if (cErr || !created) throw new Error(cErr?.message || "client insert failed");
      client = created;
    }

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
        // "Gate code or access notes" from the booking link (#527), where the
        // tech already reads Access on My Day and the visit drawer.
        ...(sr.access_notes ? { access_notes: sr.access_notes as string } : {}),
      })
      .select("id")
      .single();
    if (pErr || !property) throw new Error(pErr?.message || "property insert failed");

    // The pets the visitor named (#527), as dogs on the new property, so the
    // tech's screen says "Biscuit" rather than "1 dog". Guarded like the
    // schedule below: the customer has an account by this line, and a pet
    // row that failed to write must not become the sale being refunded.
    const pets = cleanPets(Array.isArray(sr.pets) ? (sr.pets as PetEntry[]) : []).filter(
      (p) => p.name,
    );
    // A groom booked from the booking link (#560) is booked for its pets,
    // so they are written here with the size each was priced at, one row per
    // pet counted, named as given or "Pet 2" where no name was. Unguarded,
    // unlike the plain pet rows below: without them there is no groom to
    // book, and the catch refunds the card.
    const groom = onlineGroomBookingFrom((sr as any).groom_booking);
    let groomPetIds: string[] = [];
    if (groom) {
      const given = cleanPets(Array.isArray(sr.pets) ? (sr.pets as PetEntry[]) : []);
      const count = Math.max(1, sr.dog_count ?? 1);
      const { data: rows, error: gpErr } = await supabaseAdmin
        .from("dogs")
        .insert(
          Array.from({ length: count }, (_, i) => ({
            organization_id: sr.organization_id,
            property_id: property.id,
            name: given[i]?.name || `Pet ${i + 1}`,
            breed: given[i]?.breed || null,
            weight_class: groom.pet_sizes[i] || null,
          })),
        )
        .select("id");
      if (gpErr || !rows?.length) throw new Error(gpErr?.message || "groom pets insert failed");
      groomPetIds = rows.map((r: { id: string }) => r.id);
    } else if (pets.length > 0) {
      try {
        const { error: dErr } = await supabaseAdmin.from("dogs").insert(
          pets.map((p) => ({
            organization_id: sr.organization_id,
            property_id: property.id,
            name: p.name,
            breed: p.breed || null,
          })),
        );
        if (dErr) throw dErr;
      } catch (e) {
        console.error("signup pets write failed", signupRequestId, e);
      }
    }

    // The first visit is on or after the day asked for (#527): the
    // subscription starts then, and visit generation walks from started_on,
    // so nothing is scheduled before it. A day already past starts today.
    const today = new Date().toISOString().slice(0, 10);
    const startsOn =
      sr.preferred_start_date && String(sr.preferred_start_date) > today
        ? String(sr.preferred_start_date)
        : today;

    // A groom booked online is booked the way the office books one (#560):
    // the plan's start time, length, summary and add-ons, the day checked
    // again, its visits generated. A refusal here (the time was taken in
    // the minutes since the card, the day was closed) throws into the catch,
    // which refunds the card.
    // How the service was sold (#574): one visit, a package of sessions, or
    // a repeating plan. Read from the signup row, which recorded the
    // service's mode when the card was taken. Only a repeating plan runs the
    // org-wide visit horizon below; one visit and a package book their own.
    const mode = signupBookingMode(sr.booking_mode);
    // What a one-visit or package signup bought, for its invoice below.
    let started: {
      visitId: string | null;
      subscriptionId: string | null;
      description: string;
      notes: string;
    } | null = null;
    const serviceName = await signupServiceName(supabaseAdmin, sr);

    if (groom) {
      if (!sr.service_id || !sr.preferred_start_date)
        throw new Error("groom booking has no service or day");
      const { bookGroomAppointment } = await import("@/lib/groom-booking.server");
      const booked = await bookGroomAppointment(supabaseAdmin, {
        orgId: sr.organization_id,
        actorUserId: null,
        clientId: client.id,
        propertyId: property.id,
        serviceId: sr.service_id as string,
        petIds: groomPetIds,
        addons: groom.add_on_ids.map((id) => ({ addonServiceId: id, quantity: 1 })),
        scheduledOn: String(sr.preferred_start_date),
        startTime: groom.start_time,
        everyWeeks: groom.every_weeks,
        staffId: null,
        parkingNotes: null,
        // A new customer has no vaccine records on file. A "block" rule
        // never reaches here (the link offers a request instead); a "warn"
        // rule books with the warning, as the office can.
        acknowledgeWarning: true,
        billingCadence: "prepaid",
        asService: true,
      });
      // One groom (#574): its every_weeks was recorded as none, so this
      // booked a single appointment. Its invoice is written below.
      if (mode === "one_time")
        started = {
          visitId: booked.visitId,
          subscriptionId: booked.subscriptionId,
          description: `${serviceName ?? "Groom"} on ${booked.scheduledOn}`,
          notes: "One groom, paid at online booking",
        };
    }

    if (!groom && mode === "one_time") {
      // One visit (#574): a one_time plan bounded on its own day, and that
      // day's visit generated for this plan alone, the way the office books a
      // one-off. No repeating plan and no horizon. A day the business cannot
      // work (a blackout, a day off, a hold) moves to the next one it can,
      // up to two weeks out, rather than refunding a customer for a
      // calendar they could not see.
      const { bookOneOffVisit } = await import("@/lib/one-off-visit.server");
      let day = startsOn;
      let booked: Awaited<ReturnType<typeof bookOneOffVisit>> | null = null;
      let lastError: unknown = null;
      for (let i = 0; i < 14 && !booked; i++, day = nextIsoDay(day)) {
        try {
          booked = await bookOneOffVisit(supabaseAdmin, {
            orgId: sr.organization_id,
            actorUserId: null,
            clientId: client.id,
            propertyId: property.id,
            scheduledOn: day,
            priceCents: sr.recurring_price_cents,
            ...(sr.service_id ? { serviceId: sr.service_id as string } : {}),
            asService: true,
            actorLabel: "Online signup",
            note: "paid online",
          });
        } catch (e) {
          lastError = e;
        }
      }
      if (!booked) throw lastError ?? new Error("one visit could not be scheduled");
      started = {
        visitId: booked.visitId,
        subscriptionId: booked.subscriptionId,
        description: `${serviceName ?? "Visit"} on ${booked.scheduledOn}`,
        notes: "One visit, paid at online signup",
      };
    }

    if (!groom && mode === "package") {
      // A package of sessions (#574): the paid invoice first, because the
      // client_packages row points at it, then the package, then a plan of
      // that many weekly sessions, bounded on its last one. The plan is
      // the office's own package plan: price 0, postpaid, its lessons tied
      // to the package (training_subscription_package_guard), so nothing
      // bills them again and each one counts down the package.
      const packageId = sr.service_package_id;
      if (!sr.service_id || !packageId) throw new Error("package signup has no package");
      const { data: pack, error: packErr } = await supabaseAdmin
        .from("service_packages")
        .select("id, name, sessions_count")
        .eq("id", packageId)
        .eq("organization_id", sr.organization_id)
        .single();
      if (packErr || !pack) throw new Error(packErr?.message || "package not found");
      const { billSignupStart } = await import("@/lib/signup-start-billing.server");
      const bill = await billSignupStart(supabaseAdmin, {
        orgId: sr.organization_id,
        clientId: client.id,
        currency: sr.currency ?? "usd",
        lines: [
          {
            description: `${pack.name}: ${serviceName ?? "sessions"}`,
            amountCents: paid.amountTotalCents,
          },
        ],
        notes: `${pack.name}, paid at online signup`,
        paymentIntentId: paid.paymentIntentId,
        stripeRef: paid.stripeRef,
      });
      const { newClientPackage } = await import("@/lib/db-insert");
      const packageRow = (invoiceId: string | null) =>
        newClientPackage({
          organization_id: sr.organization_id,
          client_id: client.id,
          service_package_id: pack.id,
          dog_id: null,
          invoice_id: invoiceId,
          request_id: signupRequestId,
          created_by: null,
        });
      let { data: cp, error: cpErr } = await supabaseAdmin
        .from("client_packages")
        .insert(packageRow(bill?.invoiceId ?? null))
        .select("id, sessions_count")
        .single();
      if (cpErr && bill?.invoiceId) {
        // The guard refuses an invoice whose total is not the package's
        // price now, which happens only if the owner changed the price in
        // the minutes since the card. The invoice says what was paid; the
        // package is still owed to the customer.
        console.error("signup package invoice link refused", signupRequestId, cpErr);
        ({ data: cp, error: cpErr } = await supabaseAdmin
          .from("client_packages")
          .insert(packageRow(null))
          .select("id, sessions_count")
          .single());
      }
      if (cpErr || !cp) throw new Error(cpErr?.message || "client package insert failed");
      const endsOn = packageSessionEnd(startsOn, cp.sessions_count);
      const { data: plan, error: planErr } = await supabaseAdmin
        .from("subscriptions")
        .insert({
          organization_id: sr.organization_id,
          client_id: client.id,
          property_id: property.id,
          service_id: sr.service_id as string,
          client_package_id: cp.id,
          account_type: "residential",
          dog_count: sr.dog_count,
          frequency: "weekly",
          weekdays: [isoWeekday(startsOn)],
          price_cents: 0,
          billing_cadence: "postpaid",
          zone_id: sr.zone_id,
          status: "active",
          started_on: startsOn,
          ends_on: endsOn,
        })
        .select("id")
        .single();
      if (planErr || !plan) throw new Error(planErr?.message || "package plan insert failed");
      // This plan's sessions only, through its last day. Guarded like the
      // horizon below: the package is sold and paid for by this line, and a
      // schedule that is late must not become the sale being refunded.
      try {
        // rpc-role: service (the webhook is the service role; the client and
        // property were created above for this business)
        const { error: gErr } = await (supabaseAdmin as any).rpc("generate_visits_core", {
          _org_id: sr.organization_id,
          _through: endsOn,
          _subscription_id: plan.id,
        });
        if (gErr) throw gErr;
      } catch (e) {
        console.error("signup package sessions failed", signupRequestId, e);
      }
    }

    if (!groom && mode === "recurring") {
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
        // The service signed up for (phase 5), when the visitor picked one.
        // Absent, the row is the insert it always was and tg_subscriptions_service
        // gives the plan the business's default (its pet-waste service).
        ...(sr.service_id ? { service_id: sr.service_id as string } : {}),
        status: "active",
        started_on: startsOn,
      });
      if (subErr) throw new Error(subErr.message);
    }

    // An active service must have visits immediately (QA follow-up 1.6). Every
    // other path that creates a subscription — the client wizard, the service
    // form, resume — calls this; the signup webhook was the one that did not,
    // so a homeowner who had just prepaid saw an empty schedule until the
    // nightly job ran, which is up to a day of "did my payment work?" on the
    // one screen they were sent to.
    //
    // Guarded, and the guard is the point: `generateVisitHorizon` already
    // swallows an RPC error, but nothing stops it throwing for another reason,
    // and provisioning has succeeded by this line. A thrown error here would
    // fall into the catch below, mark a provisioned signup 'failed', and refund
    // a customer who now has an account — so the schedule being late must not
    // be able to become the sale being reversed.
    try {
      const { generateVisitHorizon } = await import("@/lib/visit-generation.server");
      if (mode === "recurring") await generateVisitHorizon(supabaseAdmin, sr.organization_id);
    } catch (e) {
      console.error("signup visit generation failed", signupRequestId, e);
    }

    // The first cleanup, written down. It was always in the charge and was
    // never recorded anywhere after it — see first-cleanup-billing.server.ts.
    // Guarded for the same reason as the schedule above: the customer has an
    // account by this line, and a record that failed to write must not become
    // the sale being refunded.
    //
    // One visit (#574) is written down whole instead: one paid invoice with
    // the first cleanup, if any, and the visit, and a payment row. Nothing
    // goes to the credit balance, because nothing is left to draw it down.
    if (started) {
      try {
        const { billSignupStart } = await import("@/lib/signup-start-billing.server");
        const { firstCleanupDescription } = await import("@/lib/first-cleanup");
        const cleanupCents = sr.initial_cleanup_cents ?? 0;
        await billSignupStart(supabaseAdmin, {
          orgId: sr.organization_id,
          clientId: client.id,
          currency: sr.currency ?? "usd",
          lines: [
            ...(cleanupCents > 0
              ? [
                  {
                    description: firstCleanupDescription(
                      sr.first_cleanup_label ?? null,
                      sr.dog_count ?? 1,
                    ),
                    amountCents: cleanupCents,
                  },
                ]
              : []),
            {
              description: started.description,
              amountCents: paid.amountTotalCents - cleanupCents,
              visitId: started.visitId,
              subscriptionId: started.subscriptionId,
            },
          ],
          notes: started.notes,
          paymentIntentId: paid.paymentIntentId,
          stripeRef: paid.stripeRef,
        });
      } catch (e) {
        console.error("signup one-visit invoice failed", signupRequestId, e);
      }
    } else if (mode === "recurring" && (sr.initial_cleanup_cents ?? 0) > 0) {
      try {
        const { billSignupFirstCleanup } = await import("@/lib/first-cleanup-billing.server");
        await billSignupFirstCleanup(supabaseAdmin, {
          orgId: sr.organization_id,
          clientId: client.id,
          amountCents: sr.initial_cleanup_cents,
          currency: sr.currency ?? "usd",
          tierLabel: sr.first_cleanup_label ?? null,
          dogCount: sr.dog_count ?? 1,
          paymentIntentId: paid.paymentIntentId,
          stripeRef: paid.stripeRef,
        });
      } catch (e) {
        console.error("signup first-cleanup invoice failed", signupRequestId, e);
      }
    }

    // Credit the prepay portion to the client's balance. A repeating plan
    // only: one visit and a package were invoiced and paid in full above.
    const prepay = paid.amountTotalCents - (sr.initial_cleanup_cents ?? 0);
    if (mode === "recurring" && prepay > 0) {
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

    // The lead this signup wrote (signup.functions.ts, recordSignupLead) is
    // now a client: Leads shows it as "Started service online" with Open
    // client, rather than as somebody still waiting for a call. Through the
    // same helper the wizard uses, which only links a lead not yet linked.
    // Guarded like the schedule and the invoice above: the customer has an
    // account by this line, and a label that failed to update must not
    // become the sale being refunded.
    if (sr.lead_id) {
      try {
        const { markLeadConverted } = await import("@/lib/lead-conversion.server");
        await markLeadConverted(supabaseAdmin, sr.lead_id as string, client.id);
      } catch (e) {
        console.error("signup lead conversion failed", signupRequestId, e);
      }
    }

    // Best-effort welcome email
    try {
      const { buildPortalLink } = await import("@/lib/portal-links.server");
      const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
      // "<Business> will confirm your first visit for on or after <date>."
      // (#527), the same day the success page names.
      let firstVisitDate: string | null = null;
      try {
        const { data: org } = await (supabaseAdmin as any)
          .from("organizations")
          .select("lead_form_config")
          .eq("id", sr.organization_id)
          .maybeSingle();
        const cfg = org?.lead_form_config;
        const iso = firstVisitOnOrAfter(
          (sr.preferred_start_date as string | null) ?? null,
          String(sr.created_at ?? today).slice(0, 10),
          normalizeBookingDetails(cfg && typeof cfg === "object" ? cfg.details : null),
        );
        firstVisitDate = formatStartDate(iso, today);
      } catch (e) {
        console.error("signup first visit date failed", signupRequestId, e);
      }
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
          ...(firstVisitDate ? { firstVisitDate } : {}),
          // A groom booked online has a day and a time, not a day to confirm.
          ...(groom && sr.preferred_start_date
            ? {
                bookedGroom: bookedGroomPhrase(
                  formatStartDate(String(sr.preferred_start_date), today),
                  groom.start_time,
                ),
              }
            : {}),
        },
      });
    } catch (e) {
      console.error("signup welcome email failed", e);
    }
  } catch (e) {
    console.error("provisionSignup failed", e);

    // Give the money back.
    //
    // This branch means the card has already been charged — the webhook only
    // runs after the intent succeeded — and no account exists to show for it.
    // Until now it wrote 'failed' and stopped, so the tenant kept a homeowner's
    // first cleanup plus a prepaid visit for a service that was never set up,
    // and the only notice anyone got was a success page saying "we hit a snag".
    // Nothing swept those up: there is no reconcile job for signup_requests.
    //
    // `createSignupPaymentIntent` now pre-checks the entitlement gate, which is
    // the common cause and the better fix because it declines before the card
    // is touched. This is the backstop for everything else — a constraint, a
    // subscription that lapsed between the quote and the payment, an outage
    // mid-provision — and a backstop that returns money must be safe to run
    // twice, because Stripe redelivers.
    //
    // The refund is issued and recorded BEFORE the row is marked failed, so the
    // ordering is one a redelivery survives: `stripe_refund_id` is written in
    // the same UPDATE, and the `refunded_at` guard at the top of this function
    // stops a second attempt from provisioning or refunding again. The
    // idempotency key makes the Stripe side safe on its own even if this
    // process dies between the API call and the write.
    const refundPatch: Record<string, unknown> = {
      status: "failed",
      error_message: (e as Error).message,
    };
    if (paid.paymentIntentId) {
      try {
        const refund = await refundVia.stripe.refunds.create(
          {
            payment_intent: paid.paymentIntentId,
            reason: "requested_by_customer",
            // Hand our 50 bps back too. `feeReversalCents` and the
            // charge.refunded branch below exist for refunds the TENANT issues
            // from their own dashboard, where the platform learns about it
            // after the fact; here we are the one issuing it, so Stripe can
            // reverse the application fee as part of the same call. Keeping a
            // fee on a sale that was unwound and refunded in full would be
            // charging the tenant for our own failure.
            refund_application_fee: true,
          },
          {
            idempotencyKey: `signup-refund-${signupRequestId}`,
            ...(refundVia.stripeAccount ? { stripeAccount: refundVia.stripeAccount } : {}),
          },
        );
        refundPatch.stripe_refund_id = refund.id;
        refundPatch.refunded_at = new Date().toISOString();
        refundPatch.refunded_amount_cents = refund.amount ?? paid.amountTotalCents;
        console.warn("provisionSignup refunded the charge", {
          signupRequestId,
          refundId: refund.id,
        });
      } catch (refundErr) {
        // A refund that would not go through is worse news than the failure
        // that caused it, because now someone has to move money by hand. Say
        // so in the row the office reads, and keep the original cause: the
        // success page reads `refunded_at`, so it will correctly NOT promise a
        // refund that did not happen.
        console.error("provisionSignup refund failed", signupRequestId, refundErr);
        refundPatch.error_message =
          `${(e as Error).message}, AND the automatic refund failed ` +
          `(${(refundErr as Error).message}). This customer has been charged and has no account; ` +
          `refund payment intent ${paid.paymentIntentId} manually.`;
      }
    } else {
      // No intent id means no refundable handle reached this function, which is
      // a wiring bug in the caller rather than a payment that cannot be
      // refunded. Record it where the office will see it.
      refundPatch.error_message =
        `${(e as Error).message}, and no payment intent was passed to provisioning, ` +
        `so no refund could be issued automatically. Stripe reference ${paid.stripeRef}.`;
    }

    await supabaseAdmin.from("signup_requests").update(refundPatch).eq("id", signupRequestId);
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
                await provisionSignup(
                  supabaseAdmin,
                  signupRequestId,
                  {
                    amountTotalCents: session.amount_total ?? 0,
                    stripeRef: session.id,
                    // The session's own intent, so a failed provision can be
                    // refunded. A session id is not refundable.
                    paymentIntentId:
                      typeof session.payment_intent === "string"
                        ? session.payment_intent
                        : (session.payment_intent?.id ?? null),
                  },
                  { stripe, stripeAccount: event.account ?? null },
                );
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
                await provisionSignup(
                  supabaseAdmin,
                  piSignupId,
                  {
                    amountTotalCents: pi.amount,
                    stripeRef: pi.id,
                    paymentIntentId: pi.id,
                  },
                  { stripe, stripeAccount: event.account ?? null },
                );
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
                //
                // A tipped charge is invoice + tip, and the tip is kept apart
                // on exactly the same terms: `tip_cents` beside `amount_cents`,
                // so the invoice is paid by its own amount and never credited
                // the gratuity, and no revenue figure, royalty or AR balance
                // ever counts it.
                const { invoiceAppliedCents, surchargeFromMetadata, tipAppliedCents } =
                  await import("@/lib/processing-fee.server");
                const claimed = await markInvoicePaidFromStripe(supabaseAdmin, {
                  invoiceId: inv.id,
                  organizationId: inv.organization_id,
                  amountCents: invoiceAppliedCents(pi.amount, pi.metadata),
                  surchargeCents: surchargeFromMetadata(pi.metadata),
                  tipCents: tipAppliedCents(pi.amount, pi.metadata),
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
              const { invoiceAppliedCents, surchargeFromMetadata, tipAppliedCents } =
                await import("@/lib/processing-fee.server");
              await supabaseAdmin.from("payments").insert({
                organization_id: (invOwner as any).organization_id,
                collected_by_organization_id: await collectingOrgIdFor(
                  (invOwner as any).organization_id,
                ),
                invoice_id: invoiceId,
                amount_cents: invoiceAppliedCents(pi.amount, pi.metadata),
                surcharge_cents: surchargeFromMetadata(pi.metadata),
                tip_cents: tipAppliedCents(pi.amount, pi.metadata),
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
                // Dunning: count this decline toward the ladder and pause
                // autopay at the org's threshold, ONCE per PaymentIntent.
                // Stripe redelivers this event, and until 2026-10-07 every
                // delivery added one, as did the nightly run for the same
                // charge, so autopay paused after as few as half the declines
                // the business set. The count, the idempotency and the pause
                // are one SQL function (autopay-decline.server). If it fails
                // this throws, the handler answers 500, and Stripe's
                // redelivery is safe because a second report counts nothing.
                const { countAutopayDecline } = await import("@/lib/autopay-decline.server");
                const decline = await countAutopayDecline(supabaseAdmin, {
                  clientId: inv.client_id,
                  paymentIntentId: pi.id,
                  error: err,
                });

                // Tell the client, by email. An AUTOPAY decline only: the
                // portal_saved_card source is the client pressing Pay in their
                // own portal, who has just watched the decline happen. Once per
                // invoice per day of the decline, so Stripe's redeliveries and
                // a second failure the same day send nothing; the opt-outs are
                // the overdue reminders' own. See declined-card-email.server.
                // Until 2026-10-07 the text below was the only notice, and with
                // no business able to text yet, the client got nothing.
                if (failSource === "autopay") {
                  try {
                    const { emailClientAboutDeclinedCard } =
                      await import("@/lib/declined-card-email.server");
                    const res = await emailClientAboutDeclinedCard({
                      organizationId: inv.organization_id,
                      clientId: inv.client_id,
                      invoiceId,
                      amountCents: invoiceAppliedCents(pi.amount, pi.metadata),
                      declinedAt:
                        typeof event.created === "number"
                          ? new Date(event.created * 1000)
                          : new Date(),
                    });
                    if (!res.ok) {
                      console.info("payment-failed email not sent", res.reason, invoiceId);
                    }
                  } catch (e) {
                    console.error("payment-failed email failed", e);
                  }
                }

                // The text and the office's notice go once per decline, on the
                // delivery that counted it. A redelivery of a decline already
                // counted is the same decline told again, and used to text the
                // client and notify the office again with it. (The email above
                // has its own once-a-day guard.)
                if (decline.counted) {
                  // Optional SMS alert to client (org toggle)
                  try {
                    const { data: org } = await supabaseAdmin
                      .from("organizations")
                      .select("notify_sms_payment_failed")
                      .eq("id", inv.organization_id)
                      .single();
                    // A text to a business's client: from the business's own
                    // subaccount, or not at all. This preferred the PLATFORM
                    // number until 2026-10-06. With no subaccount the client
                    // is not texted; the office's in-app notice below still
                    // goes, and so do the nightly overdue-invoice emails.
                    const { endCustomerSmsSender } =
                      await import("@/lib/twilio-credentials.server");
                    const sender = org?.notify_sms_payment_failed
                      ? await endCustomerSmsSender(inv.organization_id)
                      : null;
                    if (org?.notify_sms_payment_failed && !sender) {
                      console.info(
                        "payment-failed SMS not sent: the business has no texting number of its own",
                        inv.organization_id,
                      );
                    }
                    if (sender) {
                      const { data: c } = await supabaseAdmin
                        .from("clients")
                        .select(
                          "display_name, primary_phone, sms_opt_out, portal_token, comms_paused",
                        )
                        .eq("id", inv.client_id)
                        .single();
                      // comms_paused: imported clients get no automated dunning
                      // SMS until the org initiates contact.
                      // Consent, via the one SQL gate every manual sender uses.
                      // This automated path checked three of its four conditions
                      // by hand and skipped the recorded-consent one, which is
                      // the condition Twilio verification turns on.
                      const { data: mayTextDeclined } = await (supabaseAdmin as any).rpc(
                        "client_may_be_texted",
                        { _client_id: inv.client_id },
                      );
                      if (
                        c &&
                        mayTextDeclined &&
                        !c.sms_opt_out &&
                        !c.comms_paused &&
                        c.primary_phone
                      ) {
                        const { sendTwilioSms } = await import("@/lib/twilio.server");
                        const { buildPortalLink } = await import("@/lib/portal-links.server");
                        const url = await buildPortalLink(
                          inv.organization_id,
                          c.portal_token as string | null,
                        );
                        const body = `Hi ${c.display_name}, your card on file was declined. Please update your payment method: ${url}`;
                        const r = await sendTwilioSms({
                          to: c.primary_phone,
                          body,
                          from: sender.from ?? undefined,
                          messagingServiceSid: sender.messagingServiceSid ?? undefined,
                          credentials: sender.credentials,
                        });
                        await supabaseAdmin.from("messages").insert({
                          organization_id: inv.organization_id,
                          client_id: inv.client_id,
                          direction: "outbound",
                          body,
                          from_number: sender.from,
                          to_number: c.primary_phone,
                          twilio_sid: r.sid,
                          status:
                            (r.status as
                              | "queued"
                              | "sent"
                              | "delivered"
                              | "failed"
                              | "received"
                              | undefined) ?? "queued",
                        });
                      }
                    }
                  } catch (e) {
                    console.error("payment-failed SMS failed", e);
                  }

                  // In-app notification to owners/managers.
                  try {
                    const { notifyRoles } = await import("@/lib/notify-center.server");
                    const { invoiceRef } = await import("@/lib/invoice-labels");
                    await notifyRoles(["owner", "office_manager"], {
                      orgId: inv.organization_id,
                      type: "payment_failed",
                      title: "A client payment failed",
                      body: `Invoice ${await invoiceRef(supabaseAdmin, invoiceId)}: card declined.`,
                      link: "/invoices",
                    });
                  } catch (e) {
                    console.error("payment-failed in-app notification failed", e);
                  }
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
              // tax_cents: the sales-tax share inside amount_cents, which a
              // refund gives back to the customer but never took off revenue.
              .select("id, organization_id, amount_cents, surcharge_cents, tip_cents, tax_cents")
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
              Number(rpay.amount_cents ?? 0) +
                Number(rpay.surcharge_cents ?? 0) +
                Number(rpay.tip_cents ?? 0),
              Number(rpay.surcharge_cents ?? 0),
              Number(rpay.tip_cents ?? 0),
              Number(rpay.tax_cents ?? 0),
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
                .from("payments")
                .update({ status: "succeeded" })
                .eq("id", rpay.id);
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
                    `${refund?.status === "failed" ? "failed" : "was canceled"}. The money has ` +
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
                    `Payouts stay stopped until the bank details are fixed. Check Payments.`
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
              // tip_cents: the same for a tip, which was never revenue either.
              // tax_cents: the sales tax inside amount_cents. Owed to the state,
              // so the part of a reversal that was tax comes off tax collected,
              // not off revenue.
              .select("id, organization_id, amount_cents, surcharge_cents, tip_cents, tax_cents, status")
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
              // Every tenant refund lands here, whichever side started it:
              // Stripe's embedded panel on /payments, or Refund on the invoice
              // (refunds.server.ts), which writes NO ledger row of its own and
              // relies on this branch for all of it. Keep it that way — a
              // second writer would record one refund twice.
              kind = "refund";
              amount = Number(obj?.amount_refunded ?? 0);
              movesMoney = true;

              // Only the invoiced base is revenue. The surcharge was fee
              // recovery, recorded beside the amount rather than inside it, and
              // deducting it here took money off a revenue figure that never
              // contained it — understating the tenant's income by exactly the
              // fee they never earned, on every refunded surcharged payment.
              const { splitRefund } = await import("@/lib/refund-split");
              //
              // The tip's share goes back to the customer too and comes off
              // nothing: it was recorded beside the amount and never counted.
              revenueAmount = splitRefund(
                amount,
                // The charge total: base + surcharge + tip, as stored on the
                // payment.
                Number(pay.amount_cents ?? 0) +
                  Number(pay.surcharge_cents ?? 0) +
                  Number(pay.tip_cents ?? 0),
                Number(pay.surcharge_cents ?? 0),
                Number(pay.tip_cents ?? 0),
                Number(pay.tax_cents ?? 0),
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
              //
              // A tip inside a disputed charge is treated the same way, on
              // purpose and conservatively: the bank takes it along with
              // everything else, the tenant is out all of it, and deducting
              // the whole can only UNDERSTATE revenue, never overstate it.
              // The Tips received report does not deduct it a second time.
              //
              // Sales tax is the one part taken back out. It was never in
              // revenue, so deducting it would understate income by money
              // that was the state's; the disputed amount's tax share comes
              // off tax collected instead. The whole charge is treated as the
              // base here (surcharge and tip stay in, as above), so with no
              // tax on the payment this is exactly `amount`.
              {
                const { splitRefund } = await import("@/lib/refund-split");
                const chargeTotal =
                  Number(pay.amount_cents ?? 0) +
                  Number(pay.surcharge_cents ?? 0) +
                  Number(pay.tip_cents ?? 0);
                revenueAmount = splitRefund(amount, chargeTotal, 0, 0, Number(pay.tax_cents ?? 0))
                  .revenueCents;
              }
              disputeRef = typeof obj?.id === "string" ? obj.id : null;

              // ── AND OUR FEE GOES BACK TOO ───────────────────────────────
              //
              // `charge.refunded` reverses the application fee a hundred lines
              // up. A lost chargeback did not, and a lost chargeback is the
              // case where it matters most: on a refund the tenant chose to
              // give the money back, whereas here the bank took the entire
              // charge off them AND charged them a dispute fee on top. Keeping
              // our 50 bps out of that is charging a commission on money the
              // tenant never got to keep.
              //
              // Only when money actually moved. `planDisputeEvent` exists
              // precisely because `charge.dispute.created` / `closed` carry
              // inquiries as well as real chargebacks, and an inquiry that is
              // simply dropped moves nothing — reversing a fee on one would be
              // the same class of error in the other direction.
              //
              // The delta shape is copied deliberately from the refund path,
              // and it is what makes this safe without having to be certain
              // what Stripe does on our behalf: the target is computed from
              // the fee, and what Stripe has ALREADY refunded of that fee is
              // subtracted. If Stripe reverses the fee automatically on a lost
              // dispute, `amount_refunded` already equals the fee, the delta is
              // zero and this does nothing. If it does not, we reverse it. Both
              // worlds are correct, and a replayed webhook is a no-op in each.
              //
              // Isolated in its own try/catch for the reason the refund path
              // gives: the tenant's ledger and their alert are the facts that
              // have to be right, and our own fee is reconcilable afterwards
              // from Stripe's records.
              if (movesMoney) {
                const chargeId: string | null =
                  typeof obj?.charge === "string" ? obj.charge : (obj?.charge?.id ?? null);
                if (chargeId) {
                  try {
                    // Fees are the PLATFORM's, so no { stripeAccount } here —
                    // the same rule the refund path calls out. Listed by charge
                    // rather than read off the event, because a dispute object
                    // carries no application fee; only the charge does, and the
                    // charge lives on the connected account.
                    const fees = await stripe.applicationFees.list({ charge: chargeId, limit: 1 });
                    const fee = fees?.data?.[0];
                    if (fee) {
                      // The charge total, base + surcharge, from the row already
                      // loaded above — cheaper than fetching the charge from the
                      // connected account, and it is the same number: a
                      // surcharged payment is charged base + surcharge.
                      const chargeTotal =
                        Number(pay.amount_cents ?? 0) +
                        Number(pay.surcharge_cents ?? 0) +
                        Number(pay.tip_cents ?? 0);
                      const target = feeReversalCents(
                        Number(fee.amount ?? 0),
                        chargeTotal,
                        // The DISPUTED amount, not the charge total. A partial
                        // dispute takes part of the charge and should take the
                        // matching part of the fee.
                        amount,
                      );
                      const delta = target - Number(fee.amount_refunded ?? 0);
                      if (delta > 0) {
                        await stripe.applicationFees.createRefund(fee.id, { amount: delta });
                      }
                    }
                  } catch (e) {
                    console.error(
                      "application fee reversal on dispute failed",
                      { chargeId, paymentIntentId, disputeRef },
                      e,
                    );
                  }
                }
              }
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

              // A refunded PREPAID TOP-UP has to give the credit back too.
              //
              // tg_invoice_paid_credit grants `total_cents` of spendable credit
              // when a prepaid_topup invoice flips to paid. Nothing removed it.
              // So a client who bought $500 of credit, changed their mind and
              // was refunded kept a $500 balance AND had the $500 back — the
              // same dollars counted twice, spent down by apply_credit_to_invoice
              // against future invoices, reported nowhere.
              //
              // Returns 0 for any payment whose invoice is not a top-up, which
              // is almost all of them, so this is a no-op on the ordinary path.
              if (kind === "refund") {
                try {
                  await (supabaseAdmin as any).rpc("reverse_prepaid_credit_for_payment", {
                    _payment_id: pay.id,
                    _refunded_cents: amount,
                  });
                } catch (e) {
                  console.error("prepaid credit reversal failed", { paymentId: pay.id }, e);
                }
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
          // The 500 alone would reach monitoring as "stripe answered 500" (see
          // src/start.ts); this sends the exception behind it, once.
          const { reportServerError } = await import("@/lib/monitoring/report.server");
          await reportServerError(e, {
            request,
            force: true,
            tags: { hook: "stripe", stripe_event: event.type },
          });
          return new Response("Handler error", { status: 500 });
        }

        return new Response("ok", { status: 200 });
      },
    },
  },
});
