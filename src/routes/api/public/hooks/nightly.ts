import { createFileRoute } from "@tanstack/react-router";

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
        // Auth: accept the generated CRON_SECRET, the service role key as a
        // Bearer token (the same pattern pg_cron already uses for
        // /email/queue/process, read from Supabase Vault), or the project anon
        // key (per Lovable scheduled-jobs pattern). Nightly work is idempotent,
        // so the worst-case if someone triggers it is running an org's
        // automation early.
        const cronSecret = process.env.CRON_SECRET;
        const anonKey = process.env.SUPABASE_PUBLISHABLE_KEY;
        const serviceKey = process.env.SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
        const providedSecret =
          request.headers.get("x-cron-secret") ??
          new URL(request.url).searchParams.get("s");
        const providedApiKey = request.headers.get("apikey");
        const authHeader = request.headers.get("authorization");
        const bearer = authHeader?.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : null;
        const okSecret = !!(cronSecret && providedSecret === cronSecret);
        const okService = !!(serviceKey && bearer === serviceKey);
        const okAnon = !!(anonKey && providedApiKey === anonKey);
        if (!okSecret && !okService && !okAnon) return json({ error: "unauthorized" }, 401);
        // Security (C2): the anon key is public (shipped in the browser bundle),
        // so it must NOT authorize real money movement. Autopay charges run only
        // under a private credential (CRON_SECRET or the service role key); the
        // anon path can still drive the idempotent, non-charging automation.
        const canCharge = okSecret || okService;


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

        const summary: Array<Record<string, unknown>> = [];

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

          if (org.auto_invoice_enabled) {
            const { data: n, error } = await supabaseAdmin.rpc("admin_generate_invoices_for_org", {
              _org_id: org.id,
              _through: todayStr,
            });
            perOrg.invoices_generated = error ? `err: ${error.message}` : (n as number);
          }

          // Overdue reminders are automated notifications → PLATFORM Twilio sender.
          const { platformTwilioFrom } = await import("@/lib/twilio-credentials.server");
          const reminderFrom = platformTwilioFrom() ?? org.sms_from_number;
          if (org.overdue_reminders_enabled && (org.notify_sms_overdue_invoice ?? true) && reminderFrom) {
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

          perOrg.autopay_charged = canCharge ? await runAutopayForOrg(supabaseAdmin, org.id) : 0;

          // Franchise royalty billing (finding #16): on the 1st of the month,
          // generate last month's royalty invoices for each franchise parent's
          // children. Idempotent per child+period.
          if (today.getUTCDate() === 1) {
            perOrg.royalties_generated = await generateRoyaltiesForParent(supabaseAdmin, org.id, today);
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

        return json({ ok: true, ran_at: new Date().toISOString(), orgs: summary });
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

// Generate last month's royalty invoices for a franchise parent's children
// (finding #16). Runs as service-role from the nightly cron (no user session).
async function generateRoyaltiesForParent(supabaseAdmin: any, parentOrgId: string, today: Date): Promise<number | string> {
  const start = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const startStr = start.toISOString().slice(0, 10);
  const endStr = end.toISOString().slice(0, 10);

  const { data: children, error } = await supabaseAdmin
    .from("organizations")
    .select("id, franchise_royalty_percent")
    .eq("parent_organization_id", parentOrgId);
  if (error) return `err: ${error.message}`;
  if (!children || children.length === 0) return 0;

  let generated = 0;
  for (const child of children as any[]) {
    const percent = Number(child.franchise_royalty_percent ?? 0);
    const { data: pays } = await supabaseAdmin
      .from("payments")
      .select("amount_cents")
      .eq("organization_id", child.id)
      .eq("status", "succeeded")
      .gte("created_at", `${startStr}T00:00:00Z`)
      .lt("created_at", `${endStr}T00:00:00Z`);
    const revenue = (pays ?? []).reduce((s: number, r: any) => s + Number(r.amount_cents ?? 0), 0);
    const amount = Math.round((revenue * percent) / 100);
    const { error: upErr } = await supabaseAdmin
      .from("franchise_royalty_invoices")
      .upsert(
        {
          parent_organization_id: parentOrgId,
          child_organization_id: child.id,
          period_start: startStr,
          period_end: endStr,
          revenue_cents: revenue,
          royalty_percent: percent,
          amount_cents: amount,
          status: "draft",
        },
        { onConflict: "child_organization_id,period_start,period_end" },
      );
    if (!upErr) generated += 1;
  }
  return generated;
}

async function sendOverdueReminders(
  supabaseAdmin: any,
  orgId: string,
  from: string,
  reminderDays: number,
): Promise<number | string> {
  const cutoffIso = new Date(Date.now() - reminderDays * 86400000).toISOString();
  const { data: invoices, error } = await supabaseAdmin
    .from("invoices")
    .select("id, client_id, total_cents, issued_at, last_reminder_at, kind")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .lte("issued_at", cutoffIso);
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
    .select("id, display_name, primary_phone, sms_opt_out, portal_token")
    .in("id", clientIds);
  const byId = new Map((clients ?? []).map((c: any) => [c.id, c]));

  const { sendTwilioSms } = await import("@/lib/twilio.server");
  const { buildPortalLink, ensureOrgSlug } = await import("@/lib/portal-links.server");
  const slug = await ensureOrgSlug(orgId).catch(() => null);
  let sent = 0;
  for (const inv of eligible) {
    const client = byId.get(inv.client_id) as any;
    if (!client || client.sms_opt_out || !client.primary_phone) continue;
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
  return sent;
}

function appUrl() {
  return process.env.APP_URL || "https://app.houndstack.com";
}

async function sendOverdueEmails(
  supabaseAdmin: any,
  orgId: string,
  reminderDays: number,
): Promise<number | string> {
  const cutoffIso = new Date(Date.now() - reminderDays * 86400000).toISOString();
  const { data: invoices, error } = await supabaseAdmin
    .from("invoices")
    .select("id, client_id, total_cents, issued_at, last_email_reminder_at")
    .eq("organization_id", orgId)
    .eq("status", "open")
    .lte("issued_at", cutoffIso);
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
  for (const inv of eligible) {
    const client = byId.get(inv.client_id) as any;
    if (!client) continue;
    const invoiceUrl = (await buildPortalLink(orgId, client.portal_token, slug)) ?? appUrl();
    const daysPastDue = Math.floor(
      (Date.now() - new Date(inv.issued_at).getTime()) / 86400000,
    );
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
    }
  }
  return sent;
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
  const retryDays: number[] = Array.isArray(org?.dunning_retry_days) && org.dunning_retry_days.length > 0
    ? org.dunning_retry_days
    : [1, 3, 7];
  const pauseAfter: number = org?.dunning_pause_after_failures ?? 3;

  const { data: invoices } = await supabaseAdmin
    .from("invoices")
    .select("id, client_id, total_cents, currency, organization_id, status, clients!inner(id, stripe_customer_id, default_payment_method_id, autopay_enabled, autopay_paused, autopay_failure_count, autopay_last_attempt_at)")
    .eq("organization_id", orgId)
    .in("status", ["open", "draft"])
    .gt("total_cents", 0);
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

    try {
      // Stamp the attempt BEFORE charging so a re-run in the same window (or a
      // webhook lag) is gated by the dunning wait and can't double-charge (H1).
      await supabaseAdmin.from("clients")
        .update({ autopay_last_attempt_at: new Date().toISOString() })
        .eq("id", c.id);
      await stripe.paymentIntents.create({
        amount: inv.total_cents,
        currency: inv.currency ?? "usd",
        customer: c.stripe_customer_id,
        payment_method: c.default_payment_method_id,
        off_session: true,
        confirm: true,
        metadata: {
          invoice_id: inv.id,
          organization_id: inv.organization_id,
          source: "autopay",
        },
      }, {
        stripeAccount: acct.accountId,
        // Idempotent per invoice+amount: a retried request never charges twice.
        idempotencyKey: `autopay-${inv.id}-${inv.total_cents}`,
      });
      // Success bookkeeping happens in the webhook payment_intent.succeeded
      // branch, which also clears failure_count. Just count locally.
      charged++;
    } catch (e) {
      const msg = (e as Error).message || "autopay failed";
      const nextCount = failures + 1;
      await supabaseAdmin.from("clients").update({
        autopay_last_attempt_at: new Date().toISOString(),
        autopay_last_error: msg,
        autopay_failure_count: nextCount,
        autopay_paused: nextCount >= pauseAfter,
      }).eq("id", c.id);
    }
  }
  return charged;
}
