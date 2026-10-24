import { createFileRoute } from "@tanstack/react-router";
import { appOrigin } from "@/lib/app-origin";
import { platformFeeCents } from "@/lib/platform-fee";
import { invoiceEmailTaxData, taxShareCents } from "@/lib/sales-tax";
import { fetchAllPages } from "@/lib/supabase-paging.server";
import { invoiceDueCents } from "@/lib/ar";
import type { EndCustomerSmsSender } from "@/lib/twilio-credentials.server";

// POST /api/public/hooks/nightly?s=<CRON_SECRET>
// Called by pg_cron on a schedule. Iterates orgs and:
//   1) auto-generates recurring visits N days ahead (if enabled)
//   2) auto-generates postpaid invoices through today (if enabled)
//   3) sends overdue-invoice SMS reminders (if enabled + client has phone + not opted out)
// All work uses service_role via supabaseAdmin so no user session is required.

export const Route = createFileRoute("/api/public/hooks/nightly")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // AUTH: a private credential only — see cron-auth.server.ts for what the
        // anon key was, why it was accepted here, and why it is not a
        // credential. The check is shared with the other cron endpoints because
        // three copies of it had already drifted into three different strengths.
        //
        // VERIFIED BEFORE TIGHTENING THIS, because a silently dead cron would be
        // worse than the hole it closes: the live pg_cron job already sends BOTH
        // an anon `apikey` and `Authorization: Bearer <service role key>` from
        // Vault, and `clients.autopay_last_attempt_at` carries 09:00:05Z against
        // a `0 9 * * *` schedule. That stamp is written inside the charge path,
        // which only ever ran when a PRIVATE credential had authorized the
        // request — so the Bearer token is already doing the work here and
        // nothing depended on the anon path.
        const { authorizeCronRequest, cronUnauthorized } = await import("@/lib/cron-auth.server");
        const auth = authorizeCronRequest(request);
        if (!auth.ok) return cronUnauthorized("nightly", auth);

        // Everything past this point holds a private credential, so the old
        // `canCharge` split is gone — it would now be a variable that is always
        // true. If a public entry point is ever added back, the money work
        // (autopay charges, and settlement generation, which CONSUMES pending
        // franchise adjustments with no un-apply) must be gated behind that
        // split again rather than left to inherit this invariant.

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const today = new Date();
        const iso = (d: Date) => d.toISOString().slice(0, 10);
        /** The Monday of the week a date falls in, as an ISO date.
         *
         *  Two horizons in the same week are the same announcement. Comparing
         *  Mondays rather than "did the date change" is what makes the notice
         *  weekly instead of nightly, and idempotent across retries. */
        const mondayOf = (isoDate: string) => {
          const d = new Date(`${isoDate}T00:00:00Z`);
          d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
          return iso(d);
        };
        const friendlyDate = (isoDate: string) =>
          new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
            timeZone: "UTC",
            weekday: "long",
            day: "numeric",
            month: "long",
          });
        const todayStr = iso(today);

        const { data: orgs, error: orgErr } = await supabaseAdmin
          .from("organizations")
          .select(
            "id, name, service_lines, auto_generate_visits, auto_generate_days_ahead, notify_schedule_horizon, schedule_horizon_notified_on, auto_invoice_enabled, overdue_reminders_enabled, overdue_reminder_days, seasonal_deepclean_enabled, seasonal_deepclean_months, notify_sms_overdue_invoice, timezone, workday_start, workday_end, notify_email_visit_reminder, quote_followup_days",
          );
        if (orgErr) return json({ error: orgErr.message }, 500);

        // Notification retention (punch list #14): in-app notifications are
        // kept for 30 days, then swept here.
        try {
          await supabaseAdmin
            .from("app_notifications")
            .delete()
            .lt("created_at", new Date(Date.now() - 30 * 86400000).toISOString());
        } catch (e) {
          console.error("notification retention sweep failed", e);
        }

        // BUG-14: an impersonation session ended by closing the tab left no
        // stop event and no ended_at, so the audit log could not say when — or
        // whether — it finished. The window had closed either way (BUG-2's
        // server gate refuses the session); only the record was missing. This
        // stamps the end and writes one honest stop event per grant, with the
        // window-close time and a null duration rather than a fabricated one.
        // Idempotent, so a retry costs nothing.
        // Org-agnostic sweeps, run once rather than per-org.
        const globalSweeps: Record<string, unknown> = {};
        try {
          const { data: n, error } = await (supabaseAdmin as any).rpc(
            "close_abandoned_impersonation_grants",
          );
          globalSweeps.impersonation_grants_closed = error
            ? `err: ${error.message}`
            : (n as number);
        } catch (e) {
          console.error("impersonation grant sweep failed", e);
        }

        // BUILD-10: file anything our automated checks could not settle on
        // their own into the review queue, instead of leaving it to be
        // discovered by accident. Idempotent, and it never reopens an item a
        // human already decided.
        try {
          const { data: n, error } = await (supabaseAdmin as any).rpc("detect_review_items");
          globalSweeps.review_items_filed = error ? `err: ${error.message}` : (n as number);
        } catch (e) {
          console.error("review item detection failed", e);
        }

        const summary: Array<Record<string, unknown>> = [];
        if (Object.keys(globalSweeps).length) summary.push(globalSweeps);

        for (const org of orgs ?? []) {
          const perOrg: Record<string, unknown> = { org: org.name, id: org.id };

          if (org.auto_generate_visits) {
            const ahead = new Date(today);
            ahead.setDate(ahead.getDate() + (org.auto_generate_days_ahead ?? 90));
            // A generated visit that lands on a tech's today or tomorrow is a
            // stop on their route like any other (see watchTheCrew).
            const watch = await watchTheCrew(supabaseAdmin, org);
            const { data: n, error } = await supabaseAdmin.rpc("admin_generate_visits_through", {
              _org_id: org.id,
              _through: iso(ahead),
            });
            await watch.finish();
            perOrg.visits_generated = error ? `err: ${error.message}` : (n as number);

            // Say so, once a week, if they asked.
            //
            // Removing the "generate visits through <date>" button was right —
            // a recurring plan already states when its visits happen. But that
            // button was also the only thing that ever CONFIRMED generation had
            // run, and a rolling horizon is invisible by construction: working
            // perfectly looks exactly like nothing happening.
            //
            // Weekly, not nightly. "Your schedule moved forward one day" every
            // morning is noise, and noise is how a real warning gets ignored
            // later. Comparing the WEEK of the stored date to the week of the
            // new horizon makes that idempotent — a job that runs twice, or
            // retries after a failure, cannot send twice.
            if (!error && org.notify_schedule_horizon) {
              const already = (org as any).schedule_horizon_notified_on as string | null;
              if (!already || mondayOf(already) !== mondayOf(iso(ahead))) {
                try {
                  const { notifyRoles } = await import("@/lib/notify-center.server");
                  await notifyRoles(["owner", "office_manager"], {
                    orgId: org.id,
                    type: "schedule.horizon",
                    title: "Schedule filled through " + friendlyDate(iso(ahead)),
                    body: `Visits are booked out ${org.auto_generate_days_ahead ?? 90} days from today. Change how far ahead in Settings → Scheduling.`,
                    link: "/routes",
                  });
                  await supabaseAdmin
                    .from("organizations")
                    .update({ schedule_horizon_notified_on: iso(ahead) })
                    .eq("id", org.id);
                } catch (e) {
                  // Best-effort: a notification that fails must not stop the
                  // rest of the nightly run for this org or any org after it.
                  console.error("schedule horizon notice failed", org.id, e);
                }
              }
            }
          }

          // Missed-visit lifecycle (B6): move genuinely past, never-serviced
          // scheduled visits to 'missed' so they stop showing "Scheduled"
          // forever (the platform Health "stuck visits" metric). Idempotent and
          // safe to retry — only touches pre-service 'scheduled' rows strictly
          // before today with no partial start; ambiguous rows are left for
          // review (I5). Runs unconditionally (not gated on auto_generate) so
          // manually-scheduled orgs still get the cleanup. Missed visits never
          // bill (I6).
          {
            const { data: n, error } = await (supabaseAdmin as any).rpc(
              "admin_transition_missed_visits",
              { _org_id: org.id },
            );
            perOrg.visits_missed = error ? `err: ${error.message}` : (n as number);
            // A missed dog walk's client is told, once per walk (#410). Reads
            // nothing but walks, so a pet-waste business is untouched.
            if (!error) {
              const { notifyMissedWalks } = await import("@/lib/walk-notify.server");
              perOrg.missed_walks_emailed = await notifyMissedWalks(org.id, todayStr);
            }
          }

          if (org.service_lines?.includes("pet_sitting")) {
            try {
              const { notifyStaysEnding } = await import("@/lib/stay-notify.server");
              perOrg.stays_ending_emailed = await notifyStaysEnding(org.id, todayStr);
            } catch (error) {
              console.error("stay ending notices failed", org.id, error);
            }
          }

          if (org.auto_invoice_enabled) {
            // Recurring add-ons, FIRST — before the invoice run, so a charge
            // that comes due today lands on today's invoice instead of waiting
            // a full cycle.
            //
            // This link was missing entirely. `addon_subscriptions` held the
            // recurring sale, `run_billing_cycles` invoiced any `addon_charges`
            // already sitting at 'pending', and nothing in the product ever
            // turned the first into the second: the only producer was a server
            // function no screen imported. `addon_charges` had zero rows with
            // source = 'recurring', ever. See migration 20260807040000 for the
            // admin_ split that lets this run without a user session.
            const { data: ac, error: acErr } = await (supabaseAdmin as any).rpc(
              "admin_generate_addon_charges_through",
              { _org_id: org.id, _through: todayStr },
            );
            perOrg.addon_charges_generated = acErr ? `err: ${acErr.message}` : (ac as number);

            // Full auto billing with grace: run_billing_cycles respects each
            // client's billing_frequency and stamps send_after (grace window),
            // replacing the old cadence-blind admin_generate_invoices_for_org
            // sweep. Idempotent with the DB-side pg_cron run of the same fn.
            const { data: n, error } = await (supabaseAdmin as any).rpc("run_billing_cycles", {
              _org_id: org.id,
            });
            perOrg.invoices_generated = error ? `err: ${error.message}` : (n as number);

            // Grace-window auto-send: open invoices whose send_after has
            // arrived and that were never emailed get the invoice email now.
            // Rendering lives app-side (react-email), so this must run here
            // rather than in SQL. sent_at is the idempotency guard against
            // double emails. Inside the auto_invoice_enabled gate (wave-2 QA
            // finding 7) so turning the org toggle off also stops pending
            // auto-sends, not just generation.
            perOrg.invoices_auto_sent = await autoSendScheduledInvoices(
              supabaseAdmin,
              org.id,
              todayStr,
            );
          }

          // Overdue-invoice texts go to a business's client, so from the
          // business's own subaccount or not at all. They preferred the
          // PLATFORM number until 2026-10-06. With no subaccount the
          // overdue EMAILS below still go, and the run says why no text did.
          if (org.overdue_reminders_enabled && (org.notify_sms_overdue_invoice ?? true)) {
            const { endCustomerSmsSender } = await import("@/lib/twilio-credentials.server");
            const reminderSender = await endCustomerSmsSender(org.id);
            perOrg.reminders_sent = reminderSender
              ? await sendOverdueReminders(
                  supabaseAdmin,
                  org.id,
                  reminderSender,
                  org.overdue_reminder_days ?? 7,
                )
              : "skipped: the business has no texting number of its own";
          }

          // Day-before reminder, by email: see visit-reminders.server.ts.
          if (org.notify_email_visit_reminder) {
            const { sendVisitReminderEmails } = await import("@/lib/visit-reminders.server");
            perOrg.visit_reminders_emailed = await sendVisitReminderEmails(supabaseAdmin, org);
          }

          // One follow-up on a quote nobody has answered: see
          // quote-followups.server.ts. 0 days is off.
          if ((org.quote_followup_days ?? 3) > 0) {
            const { sendQuoteFollowups } = await import("@/lib/quote-followups.server");
            perOrg.quote_followups_emailed = await sendQuoteFollowups(supabaseAdmin, org);
          }

          if (org.overdue_reminders_enabled) {
            perOrg.overdue_emails_sent = await sendOverdueEmails(
              supabaseAdmin,
              org.id,
              org.overdue_reminder_days ?? 7,
            );
          }

          // Reconcile checkout-paid invoices against Stripe BEFORE autopay so a
          // stale "open" status (missed webhook) can't get double-charged.
          try {
            const { reconcileOpenInvoicesForOrg } = await import("@/lib/invoice-reconcile.server");
            perOrg.invoices_reconciled = await reconcileOpenInvoicesForOrg(org.id, 50);
          } catch (e) {
            perOrg.invoices_reconciled = `err: ${(e as Error).message}`;
          }

          perOrg.autopay_charged = await runAutopayForOrg(supabaseAdmin, org.id);

          // Franchise royalty billing (finding #16): on the 1st of the month,
          // generate last month's royalty invoices for each franchise parent's
          // locations. Idempotent per child+period, but NOT harmless — it
          // CONSUMES pending adjustments, binding each to the draft statement it
          // writes, and there is no un-apply. It ran behind the private-
          // credential gate while a public one existed; now that only private
          // credentials reach this handler at all, the gate is the front door.
          if (today.getUTCDate() === 1) {
            perOrg.royalties_generated = await generateRoyaltiesForParent(
              supabaseAdmin,
              org.id,
              today,
            );
          }

          // Seasonal deep-cleans: run on the 1st of each configured month.
          if (
            org.seasonal_deepclean_enabled &&
            today.getUTCDate() === 1 &&
            Array.isArray(org.seasonal_deepclean_months) &&
            org.seasonal_deepclean_months.includes(today.getUTCMonth() + 1)
          ) {
            const watch = await watchTheCrew(supabaseAdmin, org);
            const { data: n, error } = await supabaseAdmin.rpc(
              "admin_generate_seasonal_deepcleans",
              {
                _org_id: org.id,
                _year: today.getUTCFullYear(),
                _month: today.getUTCMonth() + 1,
              },
            );
            await watch.finish();
            perOrg.deepcleans_generated = error ? `err: ${error.message}` : (n as number);
          }

          summary.push(perOrg);
        }

        // BUILD-2: bill last month's AI overage. Runs once, AFTER the per-org
        // loop, because it is driven by the usage rollup rather than by the
        // org list — an org with no usage rows has nothing to bill, and
        // iterating every org to discover that would be the slow way round.
        //
        // Outside the loop's try/catch as well: a failure here must not be
        // attributed to whichever org happened to be last, and the run's own
        // summary is where an operator looks for "did anyone get billed".
        let aiOverage: Record<string, unknown>;
        try {
          const { runAiOverageBilling } = await import("@/lib/ai-overage-billing.server");
          const r = await runAiOverageBilling();
          aiOverage = {
            billed: r.billed,
            cents_total: r.centsTotal,
            // The reasons, counted. A run that skips everything for the same
            // reason every night is a broken run wearing a green summary.
            skipped_reasons: r.outcomes.reduce<Record<string, number>>((acc, o) => {
              if ("skipped" in o)
                acc[o.skipped.split(":")[0]] = (acc[o.skipped.split(":")[0]] ?? 0) + 1;
              return acc;
            }, {}),
          };
        } catch (e) {
          console.error("[nightly] ai overage billing failed", e);
          aiOverage = { error: (e as Error).message };
        }

        // ── Coordinates for the two routing anchors ────────────────────────
        //
        // staff_start_point (20260815180000) falls back to the business
        // location and then to the nearest disposal site when a technician has
        // no start address of their own. Both tiers were dead on arrival:
        // organizations and waste_disposal_facilities store a text address and
        // nothing a planner can measure against.
        //
        // Saving either record geocodes it now, but that only helps records
        // somebody happens to re-save. This catches the ones already on file.
        //
        // Bounded to 25 a night on purpose. It is a backfill with a finite end
        // — every row either gets coordinates or has no address to geocode —
        // and an unbounded loop over every tenant on a third-party geocoder is
        // how a nightly job turns into an incident.
        let anchors: Record<string, unknown>;
        try {
          const { geocodeAddresses } = await import("@/lib/geocode.server");
          let orgsFixed = 0;
          let facilitiesFixed = 0;

          const { data: needOrg } = await supabaseAdmin
            .from("organizations")
            .select("id, contact_address")
            .not("contact_address", "is", null)
            .is("latitude", null)
            .limit(25);
          const { data: needFac } = await supabaseAdmin
            .from("waste_disposal_facilities")
            .select("id, address")
            .not("address", "is", null)
            .is("latitude", null)
            .limit(25);

          // Both lists in ONE geocoder call: a single Geocodio batch request
          // when GEOCODIO_API_KEY is set, the 1/s Nominatim loop when not.
          // Answers come back in input order, orgs first.
          const orgRows = needOrg ?? [];
          const facRows = needFac ?? [];
          const geos = await geocodeAddresses([
            ...orgRows.map((o) => ({ street: o.contact_address })),
            ...facRows.map((f) => ({ street: f.address })),
          ]);

          for (const [i, o] of orgRows.entries()) {
            const geo = geos[i];
            if (!geo) continue;
            await supabaseAdmin
              .from("organizations")
              .update({ latitude: geo.latitude, longitude: geo.longitude })
              .eq("id", (o as any).id);
            orgsFixed++;
          }

          for (const [i, f] of facRows.entries()) {
            const geo = geos[orgRows.length + i];
            if (!geo) continue;
            await supabaseAdmin
              .from("waste_disposal_facilities")
              .update({ latitude: geo.latitude, longitude: geo.longitude })
              .eq("id", (f as any).id);
            facilitiesFixed++;
          }

          // Both counts reported even at zero. "Nothing left to geocode" and
          // "the geocoder returned nothing all night" look identical from the
          // outside otherwise, and only one of them is fine.
          anchors = {
            orgs_geocoded: orgsFixed,
            orgs_pending: (needOrg?.length ?? 0) - orgsFixed,
            facilities_geocoded: facilitiesFixed,
            facilities_pending: (needFac?.length ?? 0) - facilitiesFixed,
          };
        } catch (e) {
          console.error("[nightly] routing anchor geocoding failed", e);
          anchors = { error: (e as Error).message };
        }

        // The trial-expiry notice. Outside the per-org loop for the same
        // reason ai_overage is: it selects the handful of orgs inside the
        // warning window directly, and a failure here must not be attributed
        // to whichever org happened to be last.
        //
        // This is the ONLY thing that warns an app-side trial. Stripe's
        // customer.subscription.trial_will_end cannot fire for these -- they
        // have no Stripe subscription -- so if this step stops running, nobody
        // is told anything and the expired banner's promise goes back to being
        // false.
        let trialNotices: Record<string, unknown>;
        try {
          const { sendTrialExpiryNotices } = await import("@/lib/trial-expiry-emails.server");
          const r = await sendTrialExpiryNotices();
          trialNotices = {
            considered: r.considered,
            enqueued: r.enqueued,
            // Reasons, counted, so a run that skips the same org every night
            // is visible as a broken run rather than a quiet one.
            skipped_reasons: r.outcomes.reduce<Record<string, number>>((acc, o) => {
              if (o.status === "skipped" && o.reason) acc[o.reason] = (acc[o.reason] ?? 0) + 1;
              return acc;
            }, {}),
            // Where the address came from. "owner_auth_email" means the org
            // never set a contact address, which is true of every trial today.
            resolved_from: r.outcomes.reduce<Record<string, number>>((acc, o) => {
              acc[o.resolvedFrom] = (acc[o.resolvedFrom] ?? 0) + 1;
              return acc;
            }, {}),
          };
        } catch (e) {
          console.error("[nightly] trial expiry notices failed", e);
          trialNotices = { error: (e as Error).message };
        }

        // Live tracking keeps a tech's latest position only while "on my
        // way" is live. Starting the visit, pressing Stop and turning the
        // setting off each delete it at once (triggers in 20260929100000);
        // this catches the window that closed by the clock, two hours after
        // the message, with nobody touching the visit.
        let liveLocations: Record<string, unknown>;
        try {
          const { data: n, error } = await supabaseAdmin.rpc("prune_visit_live_locations");
          liveLocations = error ? { error: error.message } : { pruned: n as number };
        } catch (e) {
          console.error("[nightly] live location prune failed", e);
          liveLocations = { error: (e as Error).message };
        }

        // NP-12: the deletion of locked accounts' data. Disabled until the
        // owner switches it on (src/lib/account-deletion.server.ts); until
        // then every run is a DRY RUN that deletes nothing and reports what it
        // would, which is the report the owner reads before switching it on.
        let accountDeletion: Record<string, unknown>;
        try {
          const { runAccountDeletion } = await import("@/lib/account-deletion.server");
          const r = await runAccountDeletion();
          accountDeletion = {
            enabled: r.enabled,
            dry_run: r.dryRun,
            deployed_on: r.deployedOn,
            deployed_on_is_hypothetical: r.deployedOnIsHypothetical,
            accounts: r.accounts,
            due_now: r.dueNow,
            records_to_delete: r.recordsToDelete,
            records_kept: r.recordsKept,
            earliest_delete_after: r.earliestDeleteAfter,
            errors: r.perAccount.filter((a) => a.error).map((a) => ({ org: a.organizationId, error: a.error })),
          };
          console.log("[nightly] account deletion", JSON.stringify(accountDeletion));
        } catch (e) {
          console.error("[nightly] account deletion failed", e);
          accountDeletion = { error: (e as Error).message };
        }

        return json({
          ok: true,
          ran_at: new Date().toISOString(),
          orgs: summary,
          ai_overage: aiOverage,
          trial_notices: trialNotices,
          routing_anchors: anchors,
          live_locations: liveLocations,
          account_deletion: accountDeletion,
        });
      },
    },
  },
});

/**
 * The nightly generation puts visits on routes, and a visit that lands on a
 * tech's today or tomorrow is a stop added to their day like any a dispatcher
 * adds: the tech is told (field-notify's route watch, the actor null because
 * nobody did it), and a route on their lock screen is rebuilt.
 *
 * WHO HEARS IT, AND WHETHER IT BUZZES. This job runs at 09:00 UTC, which is
 * between 2am and 5am for every US organization. So:
 *
 *   a day after tomorrow   nobody. The watch only looks at today and
 *                          tomorrow; a stop next Thursday is something the
 *                          tech sees when they look at next Thursday. Almost
 *                          everything the nightly run generates is here: it
 *                          extends a rolling 90-day horizon by one day.
 *   today or tomorrow      the notification centre, coalesced like any burst
 *                          on that tech-day, and a PUSH only when the
 *                          organization's own clock is inside its working
 *                          day (workday_start to workday_end). At 09:00 UTC
 *                          that is no US organization: the tech finds it in
 *                          Notifications and on My Day when they open the
 *                          app, and nobody's phone lights up at 3am about
 *                          tomorrow. Keyed on the org's clock rather than on
 *                          this job's hour, so moving the schedule cannot
 *                          quietly start waking people up.
 *
 * The lock screen is refreshed either way: a Live Activity update is silent.
 * Never throws: the run carries on for this org and every org after it.
 */
async function watchTheCrew(
  supabaseAdmin: any,
  org: {
    id: string;
    timezone?: string | null;
    workday_start?: string | null;
    workday_end?: string | null;
  },
): Promise<{ finish: () => Promise<void> }> {
  try {
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const { withinWorkingHours } = await import("@/lib/field-notify");
    const { orgLocalMinutes } = await import("@/lib/org-day");
    const { data: crew } = await supabaseAdmin
      .from("staff")
      .select("id")
      .eq("organization_id", org.id)
      .eq("active", true);
    const staffIds = ((crew ?? []) as Array<{ id: string }>).map((s) => s.id);
    if (!staffIds.length) return { finish: async () => {} };
    const push = withinWorkingHours(
      orgLocalMinutes(new Date(), org.timezone || undefined),
      org.workday_start,
      org.workday_end,
      0,
    );
    const watch = await startRouteWatch({ actorUserId: null, orgId: org.id, staffIds, push });
    return {
      finish: async () => {
        try {
          const changed = await watch.finish();
          if (!changed.length) return;
          const { refreshRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
          await refreshRouteLiveActivities(changed);
        } catch (e) {
          console.error("nightly route watch failed", org.id, e);
        }
      },
    };
  } catch (e) {
    console.error("nightly route watch could not start", org.id, e);
    return { finish: async () => {} };
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Generate last month's settlements for a franchise parent's locations
// (finding #16). Runs as service-role from the nightly cron (no user session).
//
// IMP-10: this used to be a third copy of the royalty calculation, alongside
// the SQL routine and franchise.functions.ts. It computed revenue as
// `payments where status = 'succeeded'` — the BUG-21 filter — knew nothing
// about who collected the money or about refunds, and left `direction` and
// `net_due_cents` at their defaults, so an unattended nightly run produced
// statements whose headline contradicted their own arithmetic. Three
// implementations of one money calculation is a guarantee that a fix lands in
// only one of them, and that is exactly what happened.
//
// Now a thin caller. The RPC accepts service_role explicitly (see
// 20260731091000) because this job has no user session for its owner check.
async function generateRoyaltiesForParent(
  supabaseAdmin: any,
  parentOrgId: string,
  today: Date,
): Promise<number | string> {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  // The RPC returns how many statements it actually WROTE. This used to ignore
  // it and head-count the statements that exist for the period instead, which
  // is a different question: its ON CONFLICT … DO UPDATE is guarded by
  // `status = 'draft'`, so once a period's statements have been issued the RPC
  // recalculates nothing and the count still comes back full. The log then
  // claimed a fresh recalculation every night, for months, over numbers that
  // had not moved since the day they were issued.
  const { data: written, error } = await supabaseAdmin.rpc("generate_franchise_settlements", {
    _parent: parentOrgId,
    _start: startStr,
    _end: endStr,
  });
  if (error) return `err: ${error.message}`;
  const n = Number(written ?? 0);
  return n === 0 ? "0 (nothing to recalculate: no locations, or all issued)" : n;
}

// Auto-send invoices whose grace window has ended (full auto billing).
// Selects open invoices with sent_at null and send_after <= today, enqueues
// the same "invoice-sent" email the manual "Send now" action uses (identical
// idempotency key, so the email pipeline dedupes a manual send racing this
// loop), then stamps sent_at so the invoice is never emailed twice. Transient
// failures (render/enqueue) leave sent_at null and retry the next night;
// permanent skips (opt-out, suppression, no recipient, org toggle off) also
// retry, but enqueueAppEmail short-circuits those cheaply without sending.
async function autoSendScheduledInvoices(
  supabaseAdmin: any,
  orgId: string,
  todayStr: string,
): Promise<number | string> {
  // Paged. PostgREST stops at 1000 rows and says nothing — no error, no flag —
  // so an org past a thousand queued invoices would silently send the first
  // thousand and leave the rest unsent FOREVER, since each run repeats the same
  // truncated page. Unattended and about money, which is the worst combination
  // for a limit that announces itself nowhere. Ordered because paging an
  // unordered query can repeat or drop a row between pages.
  let invoices: any[] = [];
  let error: { message: string } | null = null;
  try {
    invoices = await fetchAllPages<any>((a, b) =>
      supabaseAdmin
        .from("invoices")
        .select(
          "id, client_id, subtotal_cents, tax_cents, tax_rate_bps, tax_label, total_cents, period_start, period_end, public_token, send_after, sent_at",
        )
        .eq("organization_id", orgId)
        .eq("status", "open")
        .is("sent_at", null)
        .not("send_after", "is", null)
        .lte("send_after", todayStr)
        .order("id")
        .range(a, b),
    );
  } catch (e) {
    error = { message: (e as Error).message };
  }
  if (error) return `err: ${error.message}`;
  if (!invoices?.length) return 0;

  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  const base = appUrl();
  let sent = 0;
  let pausedSkipped = 0;
  for (const inv of invoices as any[]) {
    const invoiceUrl = inv.public_token ? `${base}/pay/i/${inv.public_token}` : base;
    const period =
      inv.period_start && inv.period_end
        ? `Services from ${inv.period_start} to ${inv.period_end}`
        : undefined;
    // The invoice as a PDF, the same one the manual send attaches. Drawn only
    // when the email is going; an invoice that cannot be drawn still gets its
    // email.
    const pdfAttachment = async () => {
      const { invoicePdfAttachment } = await import("@/lib/document-pdf.server");
      const pdf = await invoicePdfAttachment(supabaseAdmin, inv.id);
      return pdf ? [pdf] : [];
    };
    try {
      const res = await enqueueAppEmail({
        organizationId: orgId,
        clientId: inv.client_id,
        templateName: "invoice-sent",
        notifyKey: "notify_email_invoice_sent",
        idempotencyKey: `invoice-sent-${inv.id}`,
        templateData: {
          amountCents: inv.total_cents,
          invoiceUrl,
          periodLabel: period,
          reminder: false,
          ...invoiceEmailTaxData(inv),
        },
        attachments: pdfAttachment,
      });
      if (res.ok) {
        await supabaseAdmin
          .from("invoices")
          .update({ sent_at: new Date().toISOString() })
          .eq("id", inv.id)
          .is("sent_at", null);
        sent++;
      } else if (res.reason === "comms_paused") {
        // Imported comms hold: leave sent_at null — the invoice auto-sends
        // once the hold is lifted (manual contact or office toggle).
        pausedSkipped++;
      }
    } catch (e) {
      console.error("invoice auto-send failed", inv.id, e);
    }
  }
  return pausedSkipped > 0 ? `${sent} sent; ${pausedSkipped} skipped (comms hold)` : sent;
}

/** `due_on` is a DATE column, so this compares calendar days, not instants. */
function dueOnCutoff(reminderDays: number): string {
  return new Date(Date.now() - reminderDays * 86400000).toISOString().slice(0, 10);
}

/** Whole days between a due date and today. Never negative: an invoice that is
 *  not yet due is not "0 days past due" by accident of rounding. */
function daysPastDueFrom(dueOn: string | null | undefined): number {
  if (!dueOn) return 0;
  const due = Date.parse(`${dueOn}T00:00:00Z`);
  if (!Number.isFinite(due)) return 0;
  return Math.max(0, Math.floor((Date.now() - due) / 86400000));
}

async function sendOverdueReminders(
  supabaseAdmin: any,
  orgId: string,
  sender: EndCustomerSmsSender,
  reminderDays: number,
): Promise<number | string> {
  const dueCutoff = dueOnCutoff(reminderDays);
  // Paged — see sendQueuedInvoices. A truncated page here means the oldest
  // thousand overdue invoices get chased and everyone past them never does.
  let invoices: any[] = [];
  let error: { message: string } | null = null;
  try {
    invoices = await fetchAllPages<any>((a, b) =>
      supabaseAdmin
        .from("invoices")
        .select("id, client_id, total_cents, issued_at, due_on, last_reminder_at, kind")
        .eq("organization_id", orgId)
        .eq("status", "open")
        .not("due_on", "is", null)
        .lte("due_on", dueCutoff)
        .order("id")
        .range(a, b),
    );
  } catch (e) {
    error = { message: (e as Error).message };
  }
  if (error) return `err: ${error.message}`;
  if (!invoices?.length) return 0;

  // Throttle: only send if never reminded, or last reminder > reminderDays ago
  const eligible = invoices.filter((inv: any) => {
    if (!inv.last_reminder_at) return true;
    const days = (Date.now() - new Date(inv.last_reminder_at).getTime()) / 86400000;
    return days >= reminderDays;
  });
  if (!eligible.length) return 0;

  const clientIds = [...new Set(eligible.map((i: any) => i.client_id))];
  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id, display_name, primary_phone, sms_opt_out, portal_token, comms_paused")
    .in("id", clientIds);
  const byId = new Map((clients ?? []).map((c: any) => [c.id, c]));

  const { sendTwilioSms } = await import("@/lib/twilio.server");
  const { buildPortalLink, ensureOrgSlug } = await import("@/lib/portal-links.server");
  const slug = await ensureOrgSlug(orgId).catch(() => null);
  let sent = 0;
  let pausedSkipped = 0;
  for (const inv of eligible) {
    const client = byId.get(inv.client_id) as any;
    if (!client || client.sms_opt_out || !client.primary_phone) continue;
    // Imported comms hold: no automated dunning SMS until the org initiates.
    if (client.comms_paused) {
      pausedSkipped++;
      continue;
    }
    // CONSENT. client_may_be_texted is the SQL gate that exists because Twilio
    // rejected toll-free verification over exactly this (error 30513), and it
    // asks the whole question -- consent recorded, not opted out, not paused,
    // has a number -- in one place so every sender agrees.
    //
    // All four MANUAL senders call it. Both AUTOMATED ones did not, and they
    // are the ones that fire without anybody watching. The guard test pinned
    // the four files that were already right and named neither of these, so it
    // was green while the hole was open.
    const { data: mayText } = await (supabaseAdmin as any).rpc("client_may_be_texted", {
      _client_id: client.id,
    });
    if (!mayText) {
      pausedSkipped++;
      continue;
    }
    const dollars = ((inv.total_cents ?? 0) / 100).toFixed(2);
    const link = await buildPortalLink(orgId, client.portal_token, slug);
    const body = `Hi ${client.display_name}, this is a friendly reminder that invoice for $${dollars} is past due. Pay: ${link}`;
    try {
      const res = await sendTwilioSms({
        to: client.primary_phone,
        body,
        from: sender.from ?? undefined,
        messagingServiceSid: sender.messagingServiceSid ?? undefined,
        credentials: sender.credentials,
      });
      await supabaseAdmin.from("messages").insert({
        organization_id: orgId,
        client_id: client.id,
        direction: "outbound",
        body,
        from_number: sender.from,
        to_number: client.primary_phone,
        twilio_sid: res.sid,
        status: res.status,
      });
      await supabaseAdmin
        .from("invoices")
        .update({ last_reminder_at: new Date().toISOString() })
        .eq("id", inv.id);
      sent++;
    } catch (e) {
      console.error("reminder send failed", inv.id, e);
    }
  }
  return pausedSkipped > 0 ? `${sent} sent; ${pausedSkipped} skipped (comms hold)` : sent;
}

function appUrl() {
  return appOrigin();
}

// Dunning is aged from `due_on`, NEVER from `issued_at`.
//
// Both of these selected `issued_at <= now - reminderDays`, which is not a
// measure of lateness at all — it is a measure of how long ago the invoice was
// RAISED. With the stock defaults (`invoice_net_days` 15, `overdue_reminder_days`
// 7) that told a customer they were "7 days past due" on day 7, EIGHT DAYS
// BEFORE the invoice was due, by email and by SMS.
//
// `isInvoiceOverdue` in `src/lib/ar.ts` has had the correct rule the whole time
// and nothing here called it; MASTER_BRIEF even asserts that `due_on` is the
// only input to dunning. It was not.
//
// Invoices with no `due_on` are skipped rather than aged from `issued_at`: a
// missing due date is unknown lateness, and guessing it is what produced the
// wrong number in the first place.
async function sendOverdueEmails(
  supabaseAdmin: any,
  orgId: string,
  reminderDays: number,
): Promise<number | string> {
  const dueCutoff = dueOnCutoff(reminderDays);
  // Paged — see sendQueuedInvoices.
  let invoices: any[] = [];
  let error: { message: string } | null = null;
  try {
    invoices = await fetchAllPages<any>((a, b) =>
      supabaseAdmin
        .from("invoices")
        .select(
          "id, client_id, total_cents, credit_applied_cents, amount_paid_cents, issued_at, due_on, last_email_reminder_at",
        )
        .eq("organization_id", orgId)
        .eq("status", "open")
        .not("due_on", "is", null)
        .lte("due_on", dueCutoff)
        .order("id")
        .range(a, b),
    );
  } catch (e) {
    error = { message: (e as Error).message };
  }
  if (error) return `err: ${error.message}`;
  if (!invoices?.length) return 0;

  const eligible = invoices.filter((inv: any) => {
    if (!inv.last_email_reminder_at) return true;
    const days = (Date.now() - new Date(inv.last_email_reminder_at).getTime()) / 86400000;
    return days >= reminderDays;
  });
  if (!eligible.length) return 0;

  const clientIds = [...new Set(eligible.map((i: any) => i.client_id))];
  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id, portal_token")
    .in("id", clientIds);
  const byId = new Map((clients ?? []).map((c: any) => [c.id, c]));

  const { enqueueAppEmail } = await import("@/lib/email/enqueue.server");
  const { buildPortalLink, ensureOrgSlug } = await import("@/lib/portal-links.server");
  const slug = await ensureOrgSlug(orgId).catch(() => null);
  let sent = 0;
  let pausedSkipped = 0;
  for (const inv of eligible) {
    const client = byId.get(inv.client_id) as any;
    if (!client) continue;
    const invoiceUrl = (await buildPortalLink(orgId, client.portal_token, slug)) ?? appUrl();
    const daysPastDue = daysPastDueFrom(inv.due_on);
    const res = await enqueueAppEmail({
      organizationId: orgId,
      clientId: inv.client_id,
      templateName: "overdue-reminder",
      notifyKey: "notify_email_overdue",
      idempotencyKey: `overdue-${inv.id}-${new Date().toISOString().slice(0, 10)}`,
      templateData: {
        // What is past due: the balance, net of credit and of any part
        // already paid, not the invoice's original total.
        amountCents: invoiceDueCents(inv),
        daysPastDue,
        invoiceUrl,
      },
    });
    if (res.ok) {
      await supabaseAdmin
        .from("invoices")
        .update({ last_email_reminder_at: new Date().toISOString() })
        .eq("id", inv.id);
      sent++;
    } else if (res.reason === "comms_paused") {
      pausedSkipped++;
    }
  }
  return pausedSkipped > 0 ? `${sent} sent; ${pausedSkipped} skipped (comms hold)` : sent;
}

async function runAutopayForOrg(supabaseAdmin: any, orgId: string): Promise<number> {
  // Autopay charges the org's own clients → run on its connected account.
  const { resolveOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
  const acct = await resolveOrgStripeAccount(orgId);
  if (!acct || !acct.chargesEnabled) return 0;
  const { data: org } = await supabaseAdmin
    .from("organizations")
    .select("dunning_retry_days, dunning_pause_after_failures, service_lines")
    .eq("id", orgId)
    .single();
  const retryDays: number[] =
    Array.isArray(org?.dunning_retry_days) && org.dunning_retry_days.length > 0
      ? org.dunning_retry_days
      : [1, 3, 7];
  const pauseAfter: number = org?.dunning_pause_after_failures ?? 3;

  const todayStr = new Date().toISOString().slice(0, 10);
  const { data: invoices } = await supabaseAdmin
    .from("invoices")
    .select(
      "id, client_id, total_cents, tax_cents, credit_applied_cents, amount_paid_cents, currency, organization_id, status, stripe_payment_intent_id, stripe_checkout_session_id, clients!inner(id, stripe_customer_id, default_payment_method_id, autopay_enabled, autopay_paused, autopay_failure_count, autopay_last_attempt_at)",
    )
    .eq("organization_id", orgId)
    // Only open invoices: drafts are unfinalized staff WIP and must never be
    // auto-charged (charging one would also skip credit-first ordering, since
    // apply_credit_to_invoice only touches open invoices).
    .eq("status", "open")
    .gt("total_cents", 0)
    // Grace gates money too (wave-2 QA finding 3): an auto-generated invoice
    // must not be charged while it is still in its review/grace window (never
    // emailed AND send_after in the future) — owners may still edit or void
    // it. Autopay only touches invoices that were sent, have no scheduled
    // send (manual invoices), or whose send_after has arrived.
    .or(`sent_at.not.is.null,send_after.is.null,send_after.lte.${todayStr}`);
  if (!invoices?.length) return 0;

  const stripe = await connectStripe();
  const nowMs = Date.now();
  let charged = 0;

  for (const inv of invoices) {
    const c = Array.isArray(inv.clients) ? inv.clients[0] : inv.clients;
    if (!c?.autopay_enabled || !c.stripe_customer_id || !c.default_payment_method_id) continue;
    if (c.autopay_paused) continue;

    // Dunning ladder gate: after N failures, wait retryDays[N-1] days before
    // retrying. failure_count of 0 = first attempt on this invoice, allowed.
    const failures: number = c.autopay_failure_count ?? 0;
    if (failures >= pauseAfter) continue;
    if (failures > 0) {
      const waitDays = retryDays[Math.min(failures - 1, retryDays.length - 1)] ?? 7;
      const lastMs = c.autopay_last_attempt_at ? new Date(c.autopay_last_attempt_at).getTime() : 0;
      const daysSince = (nowMs - lastMs) / 86400000;
      if (daysSince < waitDays) continue;
    }

    // Stored payment activity guard: a previous night's autopay PI, or a
    // client-initiated payment, may already cover this invoice. Reconcile
    // first (rescues a missed webhook instead of charging again); then treat
    // an in-flight bank debit as "being paid" and skip; cancel a stale
    // still-confirmable intent so an abandoned pay page at the old amount
    // can't be confirmed after tonight's charge.
    if (inv.stripe_payment_intent_id || inv.stripe_checkout_session_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      const outcome = await reconcileInvoicePayment(inv.id);
      if (outcome === "marked_paid" || outcome === "already_paid") continue;
      if (inv.stripe_payment_intent_id) {
        try {
          const existing = await stripe.paymentIntents.retrieve(
            inv.stripe_payment_intent_id,
            {},
            { stripeAccount: acct.accountId },
          );
          if (existing.status === "processing") continue;
          if (
            existing.status === "requires_payment_method" ||
            existing.status === "requires_confirmation" ||
            existing.status === "requires_action"
          ) {
            await stripe.paymentIntents.cancel(existing.id, {}, { stripeAccount: acct.accountId });
          }
        } catch (e) {
          console.error("autopay stored-PI check failed", inv.id, e);
          // Unknown intent state: skip this invoice tonight rather than risk
          // charging on top of a payment we can't see.
          continue;
        }
      }
    }

    // I8 "credits auto-applied first": apply available credit through the
    // ledger BEFORE charging the card, and charge only the remaining due.
    // apply_credit_to_invoice is idempotent (advisory lock + row locks) and
    // only touches 'open' postpaid invoices; if credit fully covers the
    // invoice it is marked paid and there is nothing to charge.
    // Net of any partial payment too: autopay charges what is left.
    let dueCents = invoiceDueCents(inv);
    try {
      const { data: applied, error: applyErr } = await supabaseAdmin.rpc(
        "apply_credit_to_invoice",
        { _invoice_id: inv.id },
      );
      if (!applyErr && applied) {
        dueCents = Math.max(Number((applied as any).remaining_due_cents ?? dueCents), 0);
        if ((applied as any).invoice_status === "paid" || dueCents <= 0) continue;
      }
    } catch (e) {
      console.error("autopay credit application failed", inv.id, e);
      // Fall through and charge the last known due amount — never more.
    }
    if (dueCents <= 0) continue;

    try {
      // Stamp the attempt BEFORE charging so a re-run in the same window (or a
      // webhook lag) is gated by the dunning wait and can't double-charge (H1).
      await supabaseAdmin
        .from("clients")
        .update({ autopay_last_attempt_at: new Date().toISOString() })
        .eq("id", c.id);
      // Saved card on file, so the rail and funding type are known here without
      // a second step. This is the path the platform-fee module singled out as
      // the one nobody watches — the fee and the surcharge both have to be
      // right here with no one looking.
      const { orgFeeConfig, quoteForPaymentMethodId, surchargeMetadata } =
        await import("@/lib/processing-fee.server");
      const quote = await quoteForPaymentMethodId(stripe, {
        paymentMethodId: c.default_payment_method_id,
        stripeAccount: acct.accountId,
        baseCents: dueCents,
        // The sales tax inside what is due is not surcharged (processing-fee.ts).
        taxCents: taxShareCents(dueCents, inv.tax_cents, inv.total_cents),
        config: await orgFeeConfig(supabaseAdmin, inv.organization_id),
      });
      const { stayInvoicePaymentTypes } = await import("@/lib/stay-payment.server");
      const stayRails = org?.service_lines?.includes("pet_sitting")
        ? await stayInvoicePaymentTypes(inv.id, inv.organization_id, []) : [];
      const pi = await stripe.paymentIntents.create(
        {
          amount: quote.totalCents,
          application_fee_amount: platformFeeCents(dueCents, inv),
          currency: inv.currency ?? "usd",
          customer: c.stripe_customer_id,
          payment_method: c.default_payment_method_id,
          ...(stayRails.length ? { payment_method_types: stayRails } : {}),
          off_session: true,
          confirm: true,
          metadata: {
            invoice_id: inv.id,
            organization_id: inv.organization_id,
            source: "autopay",
            ...surchargeMetadata(quote),
          },
        },
        {
          stripeAccount: acct.accountId,
          // Idempotent per invoice+amount: a retried request never charges
          // twice. The amount is the CHARGED total (net of applied credit, plus
          // any pass-through fee), so a later credit application — or the tenant
          // switching pass-through on — mints a fresh key instead of replaying
          // this one with a different amount.
          //
          // And per UTC DAY. Stripe keeps an idempotency key for 24 hours and
          // answers a repeat with the ORIGINAL response, so with invoice+amount
          // alone, tonight's retry of last night's decline (a one-day ladder
          // step, the run landing a few minutes earlier) was handed last
          // night's decline back without the card being tried at all: a card
          // the client had fixed in the meantime stayed "declined" another
          // night. A second run on the same day still shares the key, which is
          // the protection the key was for. A charge that succeeded but whose
          // PaymentIntent was missed is still caught by reconcile above, before
          // any new key is minted.
          idempotencyKey: `autopay-${inv.id}-${quote.totalCents}-${new Date().toISOString().slice(0, 10)}`,
        },
      );
      // Store the PI on the invoice so a missed success webhook is rescued by
      // reconcile (above, next run) instead of re-charging the card. Success
      // bookkeeping (paid flip, payments row, failure_count reset) stays in
      // the webhook payment_intent.succeeded branch.
      await supabaseAdmin
        .from("invoices")
        .update({ stripe_payment_intent_id: pi.id })
        .eq("id", inv.id);
      charged++;
    } catch (e) {
      const { isStripeMissingResource, clearClientStripeRefs } =
        await import("@/lib/stripe-connect.server");
      if (isStripeMissingResource(e)) {
        // Customer/payment method no longer exists on the connected account
        // (e.g. account cutover) — clear the stale refs so autopay stops
        // retrying a dead card and staff/portal prompt for a fresh one.
        await clearClientStripeRefs(c.id);
        await supabaseAdmin
          .from("clients")
          .update({
            autopay_last_attempt_at: new Date().toISOString(),
            autopay_last_error:
              "Saved card is no longer on file. Client needs to re-add a payment method.",
          })
          .eq("id", c.id);
        continue;
      }
      // One decline counts once (autopay-decline.server). A decline that
      // reached Stripe has a PaymentIntent, and the webhook counts it when
      // Stripe reports it; counting it here as well is what made autopay pause
      // after half the declines the business set. This counts only a failure
      // that never produced a PaymentIntent, which no webhook will report.
      try {
        const { recordNightlyAutopayFailure } = await import("@/lib/autopay-decline.server");
        await recordNightlyAutopayFailure(supabaseAdmin, { clientId: c.id, error: e });
      } catch (recordErr) {
        console.error("autopay failure could not be recorded", inv.id, recordErr);
      }
    }
  }
  return charged;
}
