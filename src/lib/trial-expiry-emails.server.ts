// Telling a tenant their trial is about to end, before it ends.
//
// ── WHY THIS DID NOT EXIST ────────────────────────────────────────────────
//
// The expired banner promised "we'll tell you before anything changes" and
// there was no mechanism behind it: email-templates/registry.ts holds nine
// templates and not one is trial-related. The only trial notification in the
// codebase is `trial_ending` in routes/api/public/hooks/platform-stripe.ts,
// fired by Stripe's
// `customer.subscription.trial_will_end`.
//
// THAT EVENT CANNOT FIRE FOR THESE TRIALS, and the distinction is the whole
// reason this file exists rather than a webhook handler. HoundStack's trial is
// an APP-SIDE trial: bootstrap_organization writes plan_status='trialing' and
// trial_ends_at at signup, with no Stripe subscription and no card. Stripe's
// trial_will_end only fires for a Stripe subscription carrying a trial, so an
// org with stripe_subscription_id IS NULL is invisible to it forever. The
// template name below is `trial_expiry_notice` specifically so it never reads
// as the Stripe one in the send log.
//
// ── WHAT IT SAYS, AND WHY THAT WORDING ────────────────────────────────────
//
// It states the ratified meaning of "paused" (owner decision, 2026-08-20):
// growth pauses, the account does not. Adding a NEW customer stops; existing
// clients, jobs, routes, invoices, history and the customer portal keep
// running. That is what org_can_add_client actually enforces, and the email
// must not imply a broader freeze the product does not perform.
//
// AI IS DELIBERATELY NOT LISTED AS SOMETHING THAT STOPS, and this is the one
// line most likely to get "helpfully" added back. `aiAvailableFor` is
// `phase === "paid"`, and an active trial is `phase === "trialing"` — so AI is
// already off during the trial and expiry changes nothing about it. Naming it
// would tell a trialing customer they are about to lose a feature they have
// never had. Adding a new customer is the only thing that stops, which is why
// the sentence above says so and the lead-in says "only in one way".

// ── THE RECIPIENT, WHICH IS WHERE THIS NEARLY FAILED ──────────────────────
//
// The obvious implementation copies announcement-emails.server.ts, which
// selects organizations `.not("contact_email", "is", null)`. Checked against
// production before writing a line: the ONE organization currently in a trial
// has contact_email NULL. A notice built that way would have skipped precisely
// the account it exists for, silently, and looked like a clean run.
//
// So contact_email is preferred and the organization OWNER's auth email is the
// fallback. `resolved_from` is recorded on every outcome, because "we mailed
// the owner because the org never set a contact address" is operationally
// different from "we mailed the address they chose".

export type TrialNoticeOutcome = {
  organizationId: string;
  organizationName: string | null;
  trialEndsAt: string | null;
  daysLeft: number;
  /** Where the address came from, or why there was none. */
  resolvedFrom: "contact_email" | "owner_auth_email" | "none";
  email: string | null;
  status: "enqueued" | "skipped";
  /** Populated when status is "skipped". */
  reason?: "no_recipient" | "suppressed" | "already_sent" | "enqueue_failed";
};

export type TrialNoticeResult = {
  /** Trials inside the warning window this run considered. */
  considered: number;
  enqueued: number;
  outcomes: TrialNoticeOutcome[];
};

/** Send once, this many days before the trial ends. */
export const TRIAL_NOTICE_DAYS_BEFORE = 3;

/** The one template name. Deliberately NOT `trial_ending`, which is Stripe's. */
export const TRIAL_NOTICE_TEMPLATE = "trial_expiry_notice";

export function renderTrialNoticeHtml(input: {
  orgName: string;
  daysLeft: number;
  endsOn: string;
  billingUrl: string;
}): string {
  const { orgName, daysLeft, endsOn, billingUrl } = input;
  const when = daysLeft <= 0 ? "today" : daysLeft === 1 ? "tomorrow" : `in ${daysLeft} days`;
  return `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <div style="background:#d97706;color:#fff;padding:16px 20px;font-weight:600">Your HoundStack trial ends ${when}</div>
    <div style="padding:20px;line-height:1.55;font-size:15px">
      <p style="margin:0 0 14px">Hi ${escapeHtml(orgName)},</p>
      <p style="margin:0 0 14px">Your free trial ends on <strong>${escapeHtml(endsOn)}</strong>. Picking a plan before then keeps everything exactly as it is.</p>
      <p style="margin:0 0 8px"><strong>If the trial ends without a plan, your account pauses &mdash; but only in one way.</strong></p>
      <p style="margin:0 0 14px">What stops: <strong>adding a new customer.</strong> That is the only thing.</p>
      <p style="margin:0 0 6px">What keeps running:</p>
      <ul style="margin:0 0 14px;padding-left:20px">
        <li>Every client, job and route you already have.</li>
        <li>Scheduling, dispatch and the field app.</li>
        <li>Invoicing, taking payment, and your full billing history.</li>
        <li>Your customer portal, exactly as your customers see it today.</li>
      </ul>
      <p style="margin:0 0 18px">Nothing is deleted, at any point.</p>
      <p style="margin:0 0 18px"><a href="${billingUrl}" style="display:inline-block;background:#2563eb;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">Choose a plan</a></p>
      <p style="margin:0;font-size:13px;color:#475569">Plans start at $79 a month with your first 3 teammates included. If you have questions, reply to this email and a person will answer.</p>
    </div>
    <div style="padding:12px 20px;font-size:12px;color:#64748b;border-top:1px solid #e2e8f0">Sent by HoundStack &middot; You are receiving this because your workspace is in a free trial.</div>
  </div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderTrialNoticeText(input: {
  orgName: string;
  daysLeft: number;
  endsOn: string;
  billingUrl: string;
}): string {
  const when =
    input.daysLeft <= 0 ? "today" : input.daysLeft === 1 ? "tomorrow" : `in ${input.daysLeft} days`;
  return [
    `Your HoundStack trial ends ${when}.`,
    ``,
    `Hi ${input.orgName}, your free trial ends on ${input.endsOn}. Picking a plan before then keeps everything exactly as it is.`,
    ``,
    `If the trial ends without a plan, your account pauses - but only in one way.`,
    ``,
    `What stops: adding a new customer. That is the only thing.`,
    `What keeps running: every client, job and route you already have; scheduling, dispatch and the field app; invoicing, taking payment and your billing history; and your customer portal.`,
    `Nothing is deleted, at any point.`,
    ``,
    `Choose a plan: ${input.billingUrl}`,
    ``,
    `Plans start at $79 a month with your first 3 teammates included.`,
  ].join("\n");
}

/**
 * Find trials inside the warning window and enqueue one notice each.
 *
 * Idempotent by construction: the key is the org plus the trial's END DATE, so
 * a nightly run that fires every day inside the window mails once, and a trial
 * that is extended (a new trial_ends_at) is a new notice rather than a
 * silenced one.
 *
 * Returns what it did for every candidate rather than only what it sent. "0
 * enqueued" and "0 candidates" are different states, and a run that skips the
 * same org for the same reason every night is a broken run wearing a green
 * summary -- the shape ai-overage-billing already warns about.
 */
export async function sendTrialExpiryNotices(): Promise<TrialNoticeResult> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { appOrigin } = await import("@/lib/app-origin");

  const now = new Date();
  const windowEnd = new Date(now.getTime() + TRIAL_NOTICE_DAYS_BEFORE * 86_400_000);

  const { data: orgs, error } = await supabaseAdmin
    .from("organizations")
    .select("id, name, contact_email, trial_ends_at")
    .eq("plan_status", "trialing")
    .is("deleted_at", null)
    .not("trial_ends_at", "is", null)
    .gt("trial_ends_at", now.toISOString())
    .lte("trial_ends_at", windowEnd.toISOString());
  if (error) throw new Error(error.message);

  const outcomes: TrialNoticeOutcome[] = [];
  let enqueued = 0;

  for (const org of (orgs ?? []) as Array<{
    id: string;
    name: string | null;
    contact_email: string | null;
    trial_ends_at: string;
  }>) {
    const endsAt = new Date(org.trial_ends_at);
    const daysLeft = Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 86_400_000));

    // contact_email first, the owner's login second. See the header: the only
    // organization in a trial today has no contact_email, so a query that
    // required one would have mailed nobody and reported success.
    let email = org.contact_email;
    let resolvedFrom: TrialNoticeOutcome["resolvedFrom"] = email ? "contact_email" : "none";
    if (!email) {
      const { data: owner } = await supabaseAdmin
        .from("user_roles")
        .select("user_id")
        .eq("organization_id", org.id)
        .eq("role", "owner")
        .limit(1)
        .maybeSingle();
      if (owner?.user_id) {
        try {
          const { data: u } = await supabaseAdmin.auth.admin.getUserById(owner.user_id);
          if (u?.user?.email) {
            email = u.user.email;
            resolvedFrom = "owner_auth_email";
          }
        } catch {
          /* an owner whose auth record is unreadable is one skipped org, not a
             failed run */
        }
      }
    }

    const base: Omit<TrialNoticeOutcome, "status"> = {
      organizationId: org.id,
      organizationName: org.name,
      trialEndsAt: org.trial_ends_at,
      daysLeft,
      resolvedFrom,
      email,
    };

    if (!email) {
      outcomes.push({ ...base, status: "skipped", reason: "no_recipient" });
      continue;
    }

    const { data: sup } = await supabaseAdmin
      .from("suppressed_emails")
      .select("email")
      .eq("email", email.toLowerCase())
      .maybeSingle();
    if (sup) {
      outcomes.push({ ...base, status: "skipped", reason: "suppressed" });
      continue;
    }

    const endsOn = endsAt.toISOString().slice(0, 10);
    const idempotencyKey = `trial-expiry:${org.id}:${endsOn}`;

    // email_send_log carries no idempotency_key column -- the key lives in the
    // enqueue payload, which is how digest.server.ts does it and where the
    // queue actually dedupes. The pre-check here is so the OUTCOME can say
    // "already_sent" instead of silently enqueuing a duplicate the queue then
    // drops, and it dedupes on what the schema really has: this template, this
    // recipient, since the warning window opened.
    const windowOpened = new Date(
      endsAt.getTime() - TRIAL_NOTICE_DAYS_BEFORE * 86_400_000,
    ).toISOString();
    //
    // `failed` rows are excluded, and that exclusion is load-bearing. The log
    // row below is written BEFORE the enqueue, so a failed enqueue leaves a
    // row behind; without this filter tomorrow night would find it, report
    // `already_sent`, and never retry -- a permanent silent skip that reads in
    // the outcome as a successful send. `pending` is correctly a match: it
    // means the message did reach the queue, and redelivery is the queue's
    // job, not this sender's.
    const { data: already } = await supabaseAdmin
      .from("email_send_log")
      .select("message_id")
      .eq("template_name", TRIAL_NOTICE_TEMPLATE)
      .eq("recipient_email", email)
      .neq("status", "failed")
      .gte("created_at", windowOpened)
      .limit(1)
      .maybeSingle();
    if (already) {
      outcomes.push({ ...base, status: "skipped", reason: "already_sent" });
      continue;
    }

    const orgName = org.name ?? "there";
    const billingUrl = `${appOrigin()}/settings/billing`;
    const messageId = crypto.randomUUID();

    await supabaseAdmin.from("email_send_log").insert({
      message_id: messageId,
      template_name: TRIAL_NOTICE_TEMPLATE,
      recipient_email: email,
      status: "pending",
    });

    const { error: enqErr } = await supabaseAdmin.rpc("enqueue_email", {
      queue_name: "transactional_emails",
      payload: {
        message_id: messageId,
        to: email,
        from: "HoundStack <noreply@notify.houndstack.com>",
        sender_domain: "notify.houndstack.com",
        subject:
          daysLeft <= 1
            ? "Your HoundStack trial ends tomorrow"
            : `Your HoundStack trial ends in ${daysLeft} days`,
        html: renderTrialNoticeHtml({ orgName, daysLeft, endsOn, billingUrl }),
        text: renderTrialNoticeText({ orgName, daysLeft, endsOn, billingUrl }),
        purpose: "transactional",
        label: TRIAL_NOTICE_TEMPLATE,
        idempotency_key: idempotencyKey,
        queued_at: new Date().toISOString(),
      },
    });

    if (enqErr) {
      // The row above claims a send that did not happen. Mark it, so both the
      // dedupe above and the /platform/health card can tell "queued" from
      // "never got there" -- and so tomorrow night tries again.
      await supabaseAdmin
        .from("email_send_log")
        .update({ status: "failed", error_message: enqErr.message })
        .eq("message_id", messageId);
      outcomes.push({ ...base, status: "skipped", reason: "enqueue_failed" });
      continue;
    }
    enqueued++;
    outcomes.push({ ...base, status: "enqueued" });
  }

  return { considered: (orgs ?? []).length, enqueued, outcomes };
}
