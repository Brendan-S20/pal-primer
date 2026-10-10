// Telling the HoundStack team that a tenant added Done-for-you setup.
//
// ── WHY THIS EXISTS ───────────────────────────────────────────────────────
//
// Done-for-you setup (`developer-setup`) is work the HoundStack team does by
// hand: client import, zones, routes, add-ons, texting, payments and a
// training call. Until 2026-10-10 nobody on the team was told when a tenant
// added it. A paid one left a $199 line on a Stripe invoice; a free one
// (yearly, Scale or founding, NP-4) left nothing anywhere but the
// `org_platform_addons` row. The owner's words: "yes build the setup
// notification".
//
// ── WHO HEARS, AND THROUGH WHAT ───────────────────────────────────────────
//
// Two channels, both existing machinery:
//
//   - EMAIL to one team address: `PLATFORM_TEAM_EMAIL` if set, otherwise
//     PLATFORM_SUPPORT (support@houndstack.com, the support contact the app
//     already publishes). Sent the way the other platform-to-person emails
//     are (trial-expiry-emails.server.ts, announcement-emails.server.ts):
//     straight onto the transactional queue, from "HoundStack", with no
//     tenant branding, no tenant reply-to and no unsubscribe token minted for
//     our own mailbox. `enqueueAppEmail` is deliberately NOT used: it sends AS
//     the tenant (their name in From, their contact as Reply-To), which is
//     right for a business's client and wrong for a note to ourselves.
//
//   - IN-APP to every platform admin (`platform_admins`), through
//     `notifyUsers`, the one door every notification uses. That puts a row in
//     each admin's notification centre (the bell) and pushes it to their
//     phone. The platform console has no notifications or activity surface of
//     its own, and the bell already lists a person's rows across every org, so
//     this is the simplest surface that exists. The row links to
//     /platform/tenants/<id>.
//
// ── EXACTLY ONCE ──────────────────────────────────────────────────────────
//
// Keyed on the purchase: org + add-on + the same generation the Stripe
// idempotency key uses (`addon-buy-<org>-<addon>-<gen>`), which is the
// `org_platform_addons` row (unique on org + add-on) and its re-add
// generation. A retry after success never reaches here (the purchase answers
// `already` first); a double click that races past that check is held to one
// by the existing mechanisms:
//
//   - in-app: `event_key`, unique per recipient (20261004150000), so the second
//     insert is ON CONFLICT DO NOTHING and nobody is pushed twice;
//   - email: the message_id is derived from the key (`messageIdForKey`, the
//     same derivation `enqueueAppEmail`'s `oncePerKey` uses), the send log is
//     checked for it first, /email/queue/process refuses a message_id it has
//     logged as sent, and the key rides to Resend as the Idempotency-Key.
//
// ── NEVER AT THE PURCHASE'S EXPENSE ───────────────────────────────────────
//
// `notifyTeamOfSetup` never throws. Every lookup degrades to "not on file",
// each channel is tried on its own, and a failure is logged and reported in
// the result. The purchase has already succeeded by the time this runs, and
// nothing here can undo it.
//
// Nothing here reads, or writes to, a tenant's clients.

import type { SetupWaivedReason } from "@/lib/done-for-you-setup";

/** `app_notifications.type`. Not in NOTIFICATION_TYPES: that list is what a
 *  TENANT can mute in Settings, and this is never sent to a tenant. */
export const SETUP_ADDED_TYPE = "setup_added";

/** `email_send_log.template_name` and the queue label. */
export const SETUP_TEAM_TEMPLATE = "setup_added_team";

/** The fallback when PLATFORM_TEAM_EMAIL is unset. Pinned by a test to
 *  PLATFORM_SUPPORT in platform-inbound.server.ts, so the two cannot drift. */
export const DEFAULT_TEAM_EMAIL = "support@houndstack.com";

/** Where the team email goes. Change it with the PLATFORM_TEAM_EMAIL
 *  environment variable (Lovable project settings). */
export function setupTeamEmail(): string {
  const configured = typeof process !== "undefined" ? process.env.PLATFORM_TEAM_EMAIL?.trim() : "";
  return configured || DEFAULT_TEAM_EMAIL;
}

export type SetupCharge =
  | {
      kind: "paid";
      amountCents: number;
      /** The Stripe invoice item the $199 sits on until the next invoice. */
      invoiceItemId: string | null;
      /** The invoice, when Stripe has already put the item on one. */
      invoiceId?: string | null;
    }
  | { kind: "free"; reason: SetupWaivedReason };

export type SetupAddedEvent = {
  orgId: string;
  addonId: string;
  /** The purchase's generation: the same value the Stripe idempotency key
   *  carries ("first", or the previous row's canceled_at in ms). */
  generation: string | number;
  charge: SetupCharge;
  planSlug: string | null;
  /** The platform subscription's interval, when the purchase read it. Scale
   *  and founding setups never make a Stripe client (NP-4), so for those it is
   *  null and the message says it was not checked. */
  planInterval: "month" | "year" | null;
  at?: Date;
};

/** The purchase's key. One notification per key, ever. */
export function setupAddedKey(orgId: string, addonId: string, generation: string | number): string {
  return `setup_added:${orgId}:${addonId}:${generation}`;
}

const FREE_BECAUSE: Record<SetupWaivedReason, string> = {
  yearly: "yearly billing",
  scale: "Scale plan",
  founding: "founding account",
};

export type SetupFacts = {
  orgId: string;
  orgName: string | null;
  planName: string | null;
  planInterval: "month" | "year" | null;
  ownerName: string | null;
  ownerEmail: string | null;
  ownerPhone: string | null;
  charge: SetupCharge;
  at: Date;
  consoleUrl: string;
};

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function when(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** What the team reads. Pure, so the wording is tested without a database. */
export function describeSetupAdded(f: SetupFacts): {
  headline: string;
  subject: string;
  lines: Array<[string, string]>;
  text: string;
  html: string;
} {
  const name = f.orgName?.trim() || "A business";
  const how =
    f.charge.kind === "free"
      ? `free: ${FREE_BECAUSE[f.charge.reason]}`
      : `paid ${dollars(f.charge.amountCents)}`;
  const headline = `${name} added Done-for-you setup (${how}).`;
  const plan = f.planName?.trim() || "No plan on file";
  const interval =
    f.planInterval === "year"
      ? "billed yearly"
      : f.planInterval === "month"
        ? "billed monthly"
        : "billing interval not checked";
  const charge =
    f.charge.kind === "free"
      ? `Free (${FREE_BECAUSE[f.charge.reason]}). Nothing was charged.`
      : [
          `Paid, ${dollars(f.charge.amountCents)} one time.`,
          f.charge.invoiceItemId ? `Stripe invoice item ${f.charge.invoiceItemId}` : null,
          f.charge.invoiceId ? `on invoice ${f.charge.invoiceId}` : null,
        ]
          .filter(Boolean)
          .join(" ");
  const notOnFile = "not on file";
  const lines: Array<[string, string]> = [
    ["Business", `${name} (${f.orgId})`],
    ["Owner", f.ownerName?.trim() || notOnFile],
    ["Owner email", f.ownerEmail?.trim() || notOnFile],
    ["Owner phone", f.ownerPhone?.trim() || notOnFile],
    ["Plan", `${plan}, ${interval}`],
    ["Charge", charge],
    ["Added", when(f.at)],
    ["Platform console", f.consoleUrl],
  ];
  const text = [
    `${headline} Reach out to schedule it.`,
    "",
    ...lines.map(([k, v]) => `${k}: ${v}`),
  ].join("\n");
  const esc = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const rows = lines
    .map(([k, v]) => {
      const value =
        k === "Platform console" ? `<a href="${esc(v)}" style="color:#2563eb">${esc(v)}</a>` : esc(v);
      return `<tr><td style="padding:4px 12px 4px 0;color:#64748b;vertical-align:top;white-space:nowrap">${esc(k)}</td><td style="padding:4px 0">${value}</td></tr>`;
    })
    .join("");
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;background:#f8fafc;padding:24px;color:#0f172a">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.08)">
    <p style="margin:0 0 16px;font-size:15px;line-height:1.5"><strong>${esc(headline)}</strong> Reach out to schedule it.</p>
    <table style="font-size:14px;line-height:1.4;border-collapse:collapse">${rows}</table>
  </div></body></html>`;
  return { headline, subject: headline.replace(/\.$/, ""), lines, text, html };
}

export type SetupNotifyResult = {
  key: string;
  email: "enqueued" | "already_sent" | "failed";
  /** Platform admins whose notification row was newly written. */
  inApp: string[];
  errors: string[];
};

/** Read what the message needs. Every lookup is optional: a missing owner or
 *  plan is "not on file" in the message, never a reason not to send it. */
async function loadFacts(admin: any, e: SetupAddedEvent, consoleUrl: string): Promise<SetupFacts> {
  const facts: SetupFacts = {
    orgId: e.orgId,
    orgName: null,
    planName: null,
    planInterval: e.planInterval,
    ownerName: null,
    ownerEmail: null,
    ownerPhone: null,
    charge: e.charge,
    at: e.at ?? new Date(),
    consoleUrl,
  };
  let orgContactEmail: string | null = null;
  let orgContactPhone: string | null = null;
  try {
    const { data: org } = await admin
      .from("organizations")
      .select("id, name, contact_email, contact_phone, plan_id")
      .eq("id", e.orgId)
      .maybeSingle();
    facts.orgName = org?.name ?? null;
    orgContactEmail = org?.contact_email ?? null;
    orgContactPhone = org?.contact_phone ?? null;
    if (org?.plan_id) {
      const { data: plan } = await admin
        .from("platform_plans")
        .select("name, slug")
        .eq("id", org.plan_id)
        .maybeSingle();
      facts.planName = plan?.name ?? plan?.slug ?? null;
    }
  } catch (err) {
    console.warn("setup notification: organization lookup failed", err);
  }
  if (!facts.planName && e.planSlug) {
    facts.planName = e.planSlug.charAt(0).toUpperCase() + e.planSlug.slice(1);
  }

  // The owner: their staff row in this business first (the name and phone
  // they gave the business), then their login, then the business's own
  // contact details.
  try {
    const { data: owner } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("organization_id", e.orgId)
      .eq("role", "owner")
      .limit(1)
      .maybeSingle();
    if (owner?.user_id) {
      const { data: staff } = await admin
        .from("staff")
        .select("display_name, email, phone")
        .eq("organization_id", e.orgId)
        .eq("user_id", owner.user_id)
        .maybeSingle();
      facts.ownerName = staff?.display_name ?? null;
      facts.ownerEmail = staff?.email ?? null;
      facts.ownerPhone = staff?.phone ?? null;
      if (!facts.ownerName || !facts.ownerEmail || !facts.ownerPhone) {
        try {
          const { data: u } = await admin.auth.admin.getUserById(owner.user_id);
          const user = u?.user;
          facts.ownerEmail ||= user?.email ?? null;
          facts.ownerPhone ||= user?.phone || null;
          facts.ownerName ||=
            user?.user_metadata?.full_name ?? user?.user_metadata?.name ?? null;
        } catch {
          /* an unreadable login is a blank line in the message, not a skip */
        }
      }
    }
  } catch (err) {
    console.warn("setup notification: owner lookup failed", err);
  }
  facts.ownerEmail ||= orgContactEmail;
  facts.ownerPhone ||= orgContactPhone;
  return facts;
}

/** Enqueue the team email once per key. Returns what happened. */
async function emailTheTeam(admin: any, key: string, message: ReturnType<typeof describeSetupAdded>) {
  const { messageIdForKey } = await import("@/lib/email/enqueue.server");
  const to = setupTeamEmail().toLowerCase();
  const messageId = await messageIdForKey(SETUP_TEAM_TEMPLATE, key);

  // Every status except `failed` means it reached the queue (the same reading
  // enqueueAppEmail's oncePerKey makes).
  const { data: prior } = await admin
    .from("email_send_log")
    .select("status")
    .eq("message_id", messageId);
  if (((prior ?? []) as Array<{ status: string }>).some((r) => r.status !== "failed")) {
    return "already_sent" as const;
  }

  await admin.from("email_send_log").insert({
    message_id: messageId,
    template_name: SETUP_TEAM_TEMPLATE,
    recipient_email: to,
    status: "pending",
  });
  const { error } = await admin.rpc("enqueue_email", {
    queue_name: "transactional_emails",
    payload: {
      message_id: messageId,
      to,
      from: "HoundStack <noreply@notify.houndstack.com>",
      sender_domain: "notify.houndstack.com",
      subject: message.subject,
      html: message.html,
      text: message.text,
      purpose: "transactional",
      label: SETUP_TEAM_TEMPLATE,
      idempotency_key: key,
      queued_at: new Date().toISOString(),
    },
  });
  if (error) {
    // Turn the claim into the failure, so a later call may try again.
    await admin
      .from("email_send_log")
      .update({ status: "failed", error_message: error.message })
      .eq("message_id", messageId)
      .eq("status", "pending");
    throw new Error(`enqueue_email: ${error.message}`);
  }
  return "enqueued" as const;
}

/** Tell the platform admins in the app (bell + push). */
async function notifyPlatformAdmins(admin: any, e: SetupAddedEvent, key: string, f: SetupFacts, headline: string) {
  const { data: admins, error } = await admin.from("platform_admins").select("user_id");
  if (error) throw new Error(`platform_admins: ${error.message}`);
  const ids = ((admins ?? []) as Array<{ user_id: string }>).map((a) => a.user_id).filter(Boolean);
  if (!ids.length) return [];
  const { notifyUsers } = await import("@/lib/notify-center.server");
  const who = [f.ownerName, f.ownerEmail, f.ownerPhone].filter(Boolean).join(" · ");
  const res = await notifyUsers(ids, {
    // The row belongs to the tenant's org (the column is NOT NULL and is what
    // the row is about); RLS shows it only to its recipient, a platform admin.
    orgId: e.orgId,
    type: SETUP_ADDED_TYPE,
    title: headline,
    body: `Reach out to schedule it.${who ? ` Owner: ${who}.` : ""}`,
    link: `/platform/tenants/${e.orgId}`,
    eventKey: key,
  });
  return res.inserted;
}

/**
 * Tell the HoundStack team a tenant added Done-for-you setup. Call it after the
 * purchase has succeeded. Never throws; see the header.
 */
export async function notifyTeamOfSetup(e: SetupAddedEvent): Promise<SetupNotifyResult> {
  const key = setupAddedKey(e.orgId, e.addonId, e.generation);
  const result: SetupNotifyResult = { key, email: "failed", inApp: [], errors: [] };
  let admin: any;
  let consoleUrl = `/platform/tenants/${e.orgId}`;
  try {
    ({ supabaseAdmin: admin } = await import("@/integrations/supabase/client.server"));
    const { appUrl } = await import("@/lib/app-origin");
    consoleUrl = appUrl(`/platform/tenants/${e.orgId}`);
  } catch (err) {
    result.errors.push(`setup: ${(err as Error).message}`);
    console.error("setup notification could not start; the purchase stands", err);
    return result;
  }

  const facts = await loadFacts(admin, e, consoleUrl);
  const message = describeSetupAdded(facts);

  try {
    result.email = await emailTheTeam(admin, key, message);
  } catch (err) {
    result.errors.push(`email: ${(err as Error).message}`);
    console.error(`setup notification email failed for org ${e.orgId}; the purchase stands`, err);
  }
  try {
    result.inApp = await notifyPlatformAdmins(admin, e, key, facts, message.headline);
  } catch (err) {
    result.errors.push(`in-app: ${(err as Error).message}`);
    console.error(`setup notification in-app failed for org ${e.orgId}; the purchase stands`, err);
  }
  return result;
}
