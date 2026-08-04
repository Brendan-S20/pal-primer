import { createFileRoute } from "@tanstack/react-router";
import { appOrigin } from "@/lib/app-origin";
import { platformFeeCents } from "@/lib/platform-fee";

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
        const todayStr = iso(today);

        const { data: orgs, error: orgErr } = await supabaseAdmin
          .from("organizations")
          .select(
            "id, name, sms_from_number, auto_generate_visits, auto_generate_days_ahead, auto_invoice_enabled, overdue_reminders_enabled, overdue_reminder_days, seasonal_deepclean_enabled, seasonal_deepclean_months, notify_sms_overdue_invoice",
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
            ahead.setDate(ahead.getDate() + (org.auto_generate_days_ahead ?? 14));
            const { data: n, error } = await supabaseAdmin.rpc("admin_generate_visits_through", {
              _org_id: org.id,
              _through: iso(ahead),
            });
            perOrg.visits_generated = error ? `err: ${error.message}` : (n as number);
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
          }

          if (org.auto_invoice_enabled) {
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

          // Overdue reminders are automated notifications → PLATFORM Twilio sender.
          const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
          const reminderFrom = platformTwilioFrom() ?? org.sms_from_number;
          if (
            org.overdue_reminders_enabled &&
            (org.notify_sms_overdue_invoice ?? true) &&
            reminderFrom
          ) {
            perOrg.reminders_sent = await sendOverdueReminders(
              supabaseAdmin,
              org.id,
              reminderFrom,
              org.overdue_reminder_days ?? 7,
            );
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
            const { data: n, error } = await supabaseAdmin.rpc(
              "admin_generate_seasonal_deepcleans",
              {
                _org_id: org.id,
                _year: today.getUTCFullYear(),
                _month: today.getUTCMonth() + 1,
              },
            );
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

        return json({
          ok: true,
          ran_at: new Date().toISOString(),
          orgs: summary,
          ai_overage: aiOverage,
        });
      },
    },
  },
});

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
  return n === 0 ? "0 (nothing to recalculate — no locations, or all issued)" : n;
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
  const { data: invoices, error } = await supabaseAdmin
    .from("invoices")
    .select(
      "id, client_id, total_cents, period_start, period_end, public_token, send_after, sent_at",
    )
    .eq("organization_id", orgId)
    .eq("status", "open")
    .is("sent_at", null)
    .not("send_after", "is", null)
    .lte("send_after", todayStr);
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
        },
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
  from: string,
  reminderDays: number,
): Promise<number | string> {
  const dueCutoff = dueOnCutoff(reminderDays);
  const { data: invoices, error } = await supabaseAdmin
    .from("invoices")
    .select("id, client_id, total_cents, issued_at, due_on, last_reminder_at, kind")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .not("due_on", "is", null)
    .lte("due_on", dueCutoff);
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
    const dollars = ((inv.total_cents ?? 0) / 100).toFixed(2);
    const link = await buildPortalLink(orgId, client.portal_token, slug);
    const body = `Hi ${client.display_name}, this is a friendly reminder that invoice for $${dollars} is past due. Pay: ${link}`;
    try {
      const res = await sendTwilioSms({ from, to: client.primary_phone, body });
      await supabaseAdmin.from("messages").insert({
        organization_id: orgId,
        client_id: client.id,
        direction: "outbound",
        body,
        from_number: from,
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
  const { data: invoices, error } = await supabaseAdmin
    .from("invoices")
    .select("id, client_id, total_cents, issued_at, due_on, last_email_reminder_at")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .not("due_on", "is", null)
    .lte("due_on", dueCutoff);
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
        amountCents: inv.total_cents,
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
    .select("dunning_retry_days, dunning_pause_after_failures")
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
      "id, client_id, total_cents, credit_applied_cents, currency, organization_id, status, stripe_payment_intent_id, stripe_checkout_session_id, clients!inner(id, stripe_customer_id, default_payment_method_id, autopay_enabled, autopay_paused, autopay_failure_count, autopay_last_attempt_at)",
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
    let dueCents = Math.max((inv.total_cents ?? 0) - (inv.credit_applied_cents ?? 0), 0);
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
        config: await orgFeeConfig(supabaseAdmin, inv.organization_id),
      });
      const pi = await stripe.paymentIntents.create(
        {
          amount: quote.totalCents,
          application_fee_amount: platformFeeCents(dueCents),
          currency: inv.currency ?? "usd",
          customer: c.stripe_customer_id,
          payment_method: c.default_payment_method_id,
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
          idempotencyKey: `autopay-${inv.id}-${quote.totalCents}`,
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
      const msg = (e as Error).message || "autopay failed";
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
      const nextCount = failures + 1;
      await supabaseAdmin
        .from("clients")
        .update({
          autopay_last_attempt_at: new Date().toISOString(),
          autopay_last_error: msg,
          autopay_failure_count: nextCount,
          autopay_paused: nextCount >= pauseAfter,
        })
        .eq("id", c.id);
    }
  }
  return charged;
}
