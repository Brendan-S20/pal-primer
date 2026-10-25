import { addonPurchasable } from "@/lib/addon-launch";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { PortalSession } from "@/lib/portal-auth.server";
import { liveServiceOrFilter } from "@/lib/subscription-form";
import { orgToday } from "@/lib/org-day";
import { appUrl } from "@/lib/app-origin";
import { platformFeeCents } from "@/lib/platform-fee";
import { taxShareCents } from "@/lib/sales-tax";
import { tipChoiceSchema, tippedCharge } from "@/lib/tips";
import { formatDay } from "@/lib/format";
import { invoiceNumberLabel } from "@/lib/invoice-labels";
import {
  customerCanRequestService,
  runsPetWaste,
  serviceLinesOrDefault,
} from "@/lib/service-lines";
import {
  WALK_ISSUE_CODES,
  WALK_ISSUE_LABELS,
  YARD_ONLY_CONCERNS,
  isWalkIssue,
  isWalkLine,
  walkConcernRow,
} from "@/lib/walk-concerns";

// portal-auth.server.ts imports server-only @tanstack/react-start/server, which
// is denied in the client bundle. This file (a *.functions.ts) is reachable
// from client code, so portal-auth MUST be imported ONLY inside handler bodies
// (which the TanStack compiler strips from the client build) — never at module
// scope. Same reason we import client.server dynamically below.
async function portalAuth() {
  return import("@/lib/portal-auth.server");
}

// All portal_* RPCs are revoked from anon (finding #4) and run via
// service_role after a session check. supabaseAdmin bypasses RLS; every
// handler that touches client data first calls requirePortalSession(token),
// and every RPC still filters internally by portal_token.
async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

const tokenSchema = z.object({ token: z.string().uuid() });

const portalHomeLoaders = {
  client: loadPortalClient,
  visits: loadPortalUpcomingVisits,
  invoices: loadPortalInvoices,
  subs: loadPortalPrepaidSubs,
  catalog: loadPortalAddonCatalog,
  clientAddons: loadPortalClientAddons,
  history: loadPortalRecentVisits,
  dogs: loadPortalDogs,
  referral: loadPortalReferral,
  stations: loadPortalStations,
  requests: loadPortalMyRequests,
};

type PortalHome = {
  [K in keyof typeof portalHomeLoaders]?: Awaited<ReturnType<(typeof portalHomeLoaders)[K]>>;
};

/** How long the home parts may take. */
export const PORTAL_HOME_BUDGET_MS = 1200;

async function loadPortalHome(token: string, session: PortalSession): Promise<PortalHome> {
  // getPortalSession applies every check required by a read-only session.
  // Parts that fail, or are not back within the budget, are left out for
  // their own queries to fetch.
  const done: Record<string, unknown> = {};
  const all = Promise.all(
    Object.entries(portalHomeLoaders).map(async ([name, load]) => {
      try {
        done[name] = await load(token, session);
      } catch {
        // Left out.
      }
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    all,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, PORTAL_HOME_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  return { ...done } as PortalHome;
}

// ============ Auth entry points (no session required) ============

/**
 * Bootstrap the portal. Returns whether this device is already verified. When
 * verified, includes the full client payload; when not, returns ONLY the org
 * name and masked contact channels — no client name, balance, or schedule
 * leaks before the OTP is passed.
 */
export const portalContext = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.extend({ withHome: z.boolean().optional() }).parse(d))
  .handler(async ({ data }) => {
    const { portalContactChannels, getPortalSession } = await portalAuth();
    const contact = await portalContactChannels(data.token);
    if (!contact)
      return { verified: false as const, valid: false as const, channels: [], branding: null };

    const session = await getPortalSession(data.token);
    if (!session) {
      return {
        verified: false as const,
        valid: true as const,
        channels: contact.channels,
        branding: contact.branding,
      };
    }
    const sb = await admin();
    const { data: rows, error } = await sb.rpc("portal_get_client", { _token: data.token });
    if (error) throw new Error(error.message);
    const client = rows?.[0];
    if (!client)
      return { verified: false as const, valid: false as const, channels: [], branding: null };
    // Can this business text its clients yet? The same answer the sign-in
    // form uses. The account page's text opt-in says "coming soon" until it
    // can, rather than offering texts that are never sent.
    const { smsOtpDeliverable } = await portalAuth();
    const textsLive =
      addonPurchasable("managed-sms") &&
      (await smsOtpDeliverable(contact.organizationId).catch(() => false));
    return {
      verified: true as const,
      valid: true as const,
      client,
      textsLive,
      branding: contact.branding,
      // A staff preview: the portal shows a banner and the server refuses
      // every action (requirePortalSession).
      preview: session.preview,
      ...(data.withHome ? { home: await loadPortalHome(data.token, session) } : {}),
    };
  });

// ── Generic company sign-in (/portal/{slug}) ────────────────────────────────

/** Org branding for the generic sign-in page, by slug. */
export const portalOrgBySlug = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ slug: z.string().min(1).max(120) }).parse(d))
  .handler(async ({ data }) => {
    const { orgBrandingBySlug, smsOtpDeliverable } = await portalAuth();
    const org = await orgBrandingBySlug(data.slug);
    if (!org) return { found: false as const };
    // Whether the sign-in form may ask for a phone number: only when this
    // business can text a code from its own number. Otherwise email only.
    const textCodes = await smsOtpDeliverable(org.organizationId);
    return { found: true as const, branding: org, textCodes };
  });

/** Resolve a legacy bare token to its org slug so /portal/{uuid} can redirect. */
export const portalResolveLegacy = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { slugForToken } = await portalAuth();
    const slug = await slugForToken(data.token);
    return { slug };
  });

/** Identify a client in ONE org by phone/email and send an OTP. */
export const portalIdentify = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ slug: z.string().min(1).max(120), contact: z.string().min(3).max(200) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { portalIdentify: identify } = await portalAuth();
    return identify(data.slug, data.contact);
  });

/** Verify a generic-entry code: establishes a session, or returns a picker. */
export const portalVerifyGenericOtp = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        slug: z.string().min(1).max(120),
        contact: z.string().min(3).max(200),
        code: z.string().min(4).max(10),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { portalVerifyGeneric } = await portalAuth();
    return portalVerifyGeneric(data.slug, data.contact, data.code);
  });

/** After a multi-match verify, mint the session for the chosen account. */
export const portalChooseAccount = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { portalChooseClient } = await portalAuth();
    return portalChooseClient(data.clientId);
  });

/** Generic entry: redeem a code the client already has, without identifying. */
export const portalRedeemCode = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ slug: z.string().min(1).max(120), code: z.string().min(4).max(10) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { portalRedeemOrgCode } = await portalAuth();
    return portalRedeemOrgCode(data.slug, data.code);
  });

export const portalRequestOtp = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), channel: z.enum(["sms", "email"]) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { issuePortalOtp } = await portalAuth();
    return issuePortalOtp(data.token, data.channel);
  });

export const portalVerifyOtp = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), code: z.string().min(4).max(10) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { verifyPortalOtp } = await portalAuth();
    const ok = await verifyPortalOtp(data.token, data.code);
    return { verified: ok };
  });

// ============ Client data + the original client loader (session-gated) ============

export const portalGetClient = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalClient(data.token, session);
  });

async function loadPortalClient(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_get_client", { _token: token });
  if (error) throw new Error(error.message);
  const row = rows?.[0];
  if (!row) throw new Error("Invalid or expired portal link");
  // What a portal skip actually costs, so the Skip button can stop guessing.
  //
  // `portal_request_skip` bills the visit at the org's `customer_requested`
  // percentage and ends with `IF _pct IS NULL THEN _pct := 0` — no row means
  // free, and skip-rules.functions.ts deliberately seeds that reason at 0 to
  // match. So on a default org the customer was warned about a charge that
  // could not be raised. This is read here rather than added to
  // portal_get_client because it needs no migration: the handler already
  // holds the org id from the row and runs as service_role.
  //
  // The re-clean guarantee's window rides along the same way and for the
  // same reason: the Visits tab needs it to decide which completed visits
  // get a "Request a re-clean" button, and portal_request_reclean refuses
  // against this same column, so the button and the refusal cannot disagree
  // about which setting they read. 0 means the owner switched it off.
  //
  // A re-clean is a pet-waste promise, so a business that does not run pet
  // waste (organizations.service_lines) offers no button, whatever the
  // stored window says. Read on its own so that, on a database the
  // service-lines migration has not reached, the missing column fails this
  // read alone and the answer falls OPEN to pet waste, as everywhere else.
  // The window itself is untouched, and portal_request_reclean still
  // answers: this hides an offer, it does not refuse one.
  const { loadServiceLineAvailability } = await import("@/lib/service-line-availability.server");
  const [{ data: rule }, { data: org }, { data: lines }, availability] = await Promise.all([
    sb
      .from("skip_billing_rules")
      .select("billable_pct")
      .eq("organization_id", row.organization_id)
      .eq("reason_code", "customer_requested")
      .maybeSingle(),
    sb
      .from("organizations")
      .select("reclean_window_hours")
      .eq("id", row.organization_id)
      .maybeSingle(),
    sb.from("organizations").select("service_lines").eq("id", row.organization_id).maybeSingle(),
    loadServiceLineAvailability(),
  ]);
  const petWaste = runsPetWaste(serviceLinesOrDefault(lines?.service_lines));
  return {
    ...row,
    skip_billable_pct: rule?.billable_pct ?? 0,
    reclean_window_hours: petWaste ? Number(org?.reclean_window_hours ?? 0) : 0,
    mobile_grooming: serviceLinesOrDefault(lines?.service_lines).includes("mobile_grooming"),
    groom_requests: customerCanRequestService("mobile_grooming", availability),
  };
}

export const portalListUpcomingVisits = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalUpcomingVisits(data.token, session);
  });

async function loadPortalUpcomingVisits(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_upcoming_visits", {
    _token: token,
  });
  if (error) throw new Error(error.message);
  return rows ?? [];
}

export const portalListInvoices = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalInvoices(data.token, session);
  });

async function loadPortalInvoices(token: string, session: PortalSession) {
  const sb = await admin();
  // Webhook-independent safety net: the client may have just returned from a
  // paid Checkout (?paid=1) before the webhook landed — verify this client's
  // open sessions against Stripe so the list shows the real state.
  const { data: opens } = await sb
    .from("invoices")
    .select("id")
    .eq("client_id", session.clientId)
    .eq("status", "open")
    .or("stripe_checkout_session_id.not.is.null,stripe_payment_intent_id.not.is.null")
    .order("updated_at", { ascending: false })
    .limit(5);
  if (opens?.length) {
    const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
    for (const r of opens) await reconcileInvoicePayment(r.id);
  }
  const { data: rows, error } = await sb.rpc("portal_list_invoices", { _token: token });
  if (error) throw new Error(error.message);

  // G1: the portal must show the client's real debt — due dates, overdue
  // state, and open count/total. The RPC predates due_on; merge it from the
  // invoices table (scoped to this session's client) and compute the
  // summary with the same shared helper the staff surfaces use.
  const { isInvoiceOverdue, summarizeOpenInvoices } = await import("@/lib/overdue");
  const { invoiceOutstandingCents } = await import("@/lib/ar");
  const { data: dueRows, error: dueErr } = await sb
    .from("invoices")
    // tax_*: the sales tax inside total_cents, drawn as "includes $X sales
    // tax" beside the amount when there is any.
    // number: the stored invoice number, so the list prints INV-10427 like
    // the PDF, the email and the pay link (C-03). It used to number rows by
    // their position in the list.
    .select(
      "id, number, due_on, credit_applied_cents, amount_paid_cents, tax_cents, tax_rate_bps, tax_label",
    )
    .eq("client_id", session.clientId);
  if (dueErr) throw new Error(dueErr.message);
  const dueById = new Map(
    (
      (dueRows ?? []) as Array<{
        id: string;
        number: number | null;
        due_on: string | null;
        credit_applied_cents: number | null;
        amount_paid_cents?: number | null;
        tax_cents?: number | null;
        tax_rate_bps?: number | null;
        tax_label?: string | null;
      }>
    ).map((r) => [r.id, r]),
  );
  const invoices = (
    (rows ?? []) as Array<{
      invoice_id: string;
      status: string;
      kind: string;
      total_cents: number | null;
      issued_at: string | null;
      period_start: string | null;
      period_end: string | null;
    }>
  ).map((r) => {
    const extra = dueById.get(r.invoice_id);
    const due_on = extra?.due_on ?? null;
    const credit_applied_cents = extra?.credit_applied_cents ?? 0;
    const amount_paid_cents = extra?.amount_paid_cents ?? 0;
    return {
      ...r,
      number_label: invoiceNumberLabel({ id: r.invoice_id, number: extra?.number ?? null }),
      due_on,
      credit_applied_cents,
      amount_paid_cents,
      tax_cents: Number(extra?.tax_cents ?? 0),
      tax_rate_bps: Number(extra?.tax_rate_bps ?? 0),
      tax_label: (extra?.tax_label ?? null) as string | null,
      // What the client still owes on this invoice, net of applied credit
      // (B7) and of any partial payment.
      amount_due_cents: invoiceOutstandingCents({
        status: r.status,
        total_cents: r.total_cents,
        credit_applied_cents,
        amount_paid_cents,
      }),
      overdue: isInvoiceOverdue(r.status, due_on),
    };
  });
  const summary = summarizeOpenInvoices(invoices);
  return {
    invoices,
    openCount: summary.openCount,
    openTotalCents: summary.openTotalCents,
    overdueCount: summary.overdueCount,
    nextDueOn: summary.nextDueOn,
  };
}

export const portalListPrepaidSubs = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalPrepaidSubs(data.token, session);
  });

async function loadPortalPrepaidSubs(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_prepaid_subscriptions", {
    _token: token,
  });
  if (error) throw new Error(error.message);
  return rows ?? [];
}

export const portalRequestSkip = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        visitId: z.string().uuid(),
        reason: z.string().max(500).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    // A skip inside the cutoff takes a stop off a tech's day: that tech hears
    // it, and their lock screen is rebuilt (see portalRescheduleVisit).
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: null,
      orgId: session.organizationId,
      visitIds: [data.visitId],
    });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await sb.rpc("portal_request_skip", {
      _token: data.token,
      _visit_id: data.visitId,
      _reason: data.reason,
    });
    if (error) throw new Error(error.message);
    await watch.finish();
    await pushRoutes();
    return { ok: true };
  });

export const portalStartPrepaidTopup = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        subscriptionId: z.string().uuid(),
        visitCount: z.number().int().min(1).max(52),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: id, error } = await sb.rpc("portal_start_prepaid_topup", {
      _token: data.token,
      _subscription_id: data.subscriptionId,
      _visit_count: data.visitCount,
    });
    if (error) throw new Error(error.message);
    return { invoiceId: id as string };
  });

const frequencyEnum = z.enum(["weekly", "biweekly", "twice_weekly", "monthly"]);
const addonFreqEnum = z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]);

export const portalRescheduleVisit = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        visitId: z.string().uuid(),
        newDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    // A customer moving their visit takes it off the tech's day it was on
    // (portal_reschedule_visit unassigns it for the office to place again).
    // If that day is the tech's today or tomorrow, the tech hears it, the
    // same way they hear a dispatcher's move; the actor is null because the
    // customer is nobody on the staff. The lock screen follows both days.
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: null,
      orgId: session.organizationId,
      visitIds: [data.visitId],
    });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities([data.visitId]);
    const { error } = await sb.rpc("portal_reschedule_visit", {
      _token: data.token,
      _visit_id: data.visitId,
      _new_date: data.newDate,
    });
    if (error) throw new Error(error.message);
    await watch.finish();
    await pushRoutes();
    return { ok: true };
  });

// Finding #29: a client with 2+ properties saw one undifferentiated portal
// view with no address labels. This lists their serviced properties so the
// portal can show each address distinctly.
export const portalListProperties = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const sb = await admin();
    const { data: rows, error } = await sb
      .from("properties")
      .select("id, label, street, city, region, postal_code")
      .eq("client_id", session.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { properties: rows ?? [] };
  });

// Finding #36: the org's self-serve permission toggles (vacation hold, change
// frequency) had no matching portal UI. This returns whether each is enabled
// plus the client's active subscription, so the portal can render (only) the
// controls the owner has switched on.
export const portalSelfServeOptions = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const sb = await admin();
    // Sequential, not Promise.all: the standing-plan filter below judges
    // "still running" by a date, this code runs on a UTC worker, and the org
    // row is where the timezone lives. The old todayLocalISO() was the UTC
    // day, so from early evening on a plan ending today vanished from the
    // portal while the office still showed it.
    const { data: org } = await sb
      .from("organizations")
      .select(
        "portal_allow_vacation_hold, portal_allow_frequency_change, portal_auto_apply_changes, timezone",
      )
      .eq("id", session.organizationId)
      .maybeSingle();
    const [{ data: subs }] = await Promise.all([
      // "Your plan" has to be the client's STANDING plan.
      //
      // status='active' alone picked up services the tenant had ended (this
      // schema records ending in ends_on, not status) and — once one-off
      // bookings existed — a finished single call-out, because it is the
      // newest-started active row. The customer would then see "One time" as
      // their plan, and the subscriptionId handed to portalChangeFrequency was
      // that dead one-off: switching to biweekly rewrote a completed call-out
      // and left their real weekly service untouched, while the office got a
      // review ticket about a service that does not exist.
      sb
        .from("subscriptions")
        .select("id, frequency, status, ends_on, weekdays")
        .eq("client_id", session.clientId)
        .eq("status", "active")
        .neq("frequency", "one_time")
        .or(liveServiceOrFilter(orgToday(org?.timezone || undefined)))
        .order("started_on", { ascending: false })
        .limit(1),
    ]);
    const sub = (subs ?? [])[0] ?? null;
    return {
      allowVacationHold: !!org?.portal_allow_vacation_hold,
      allowFrequencyChange: !!org?.portal_allow_frequency_change,
      // Drives the Account tab's request-vs-update affordance (the plan row
      // gets the same flag via the client payload).
      autoApply: !!(org as any)?.portal_auto_apply_changes,
      subscription: sub
        ? {
            id: sub.id as string,
            frequency: sub.frequency as string,
            /** The days a walk plan runs on (the catalog); null for a plan
             *  that runs by its frequency. */
            weekdays: ((sub as { weekdays?: number[] | null }).weekdays ?? null) as number[] | null,
          }
        : null,
    };
  });

export const portalChangeFrequency = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        subscriptionId: z.string().uuid(),
        frequency: frequencyEnum,
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: result, error } = await sb.rpc("portal_change_frequency", {
      _token: data.token,
      _subscription_id: data.subscriptionId,
      _new_frequency: data.frequency,
    });
    if (error) throw new Error(error.message);
    // 'applied' | 'requested' | 'unchanged' — 'requested' means auto-apply is
    // off and the office got a structured review ticket instead (C4/G4).
    return { ok: true, status: result ?? "applied" };
  });

export const portalListAddonCatalog = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalAddonCatalog(data.token, session);
  });

async function loadPortalAddonCatalog(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_addon_catalog", { _token: token });
  if (error) throw new Error(error.message);
  return rows ?? [];
}

export const portalListClientAddons = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalClientAddons(data.token, session);
  });

async function loadPortalClientAddons(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_client_addons", { _token: token });
  if (error) throw new Error(error.message);
  return rows ?? [];
}

export const portalSubscribeAddon = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        addonServiceId: z.string().uuid(),
        frequency: addonFreqEnum.nullable().optional(),
        quantity: z.number().int().min(1).max(50).default(1),
        propertyId: z.string().uuid().nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: id, error } = await sb.rpc("portal_subscribe_addon", {
      _token: data.token,
      _addon_service_id: data.addonServiceId,
      _frequency: (data.frequency ?? null) as any,
      _quantity: data.quantity,
      _property_id: (data.propertyId ?? null) as any,
    });
    if (error) throw new Error(error.message);
    // In-app notification to the office (same pattern as portalReportConcern):
    // a client asked for — and may now be billed for — a new service, which
    // otherwise sat unseen until someone happened to open the client page.
    // Best-effort; never block the client's request.
    try {
      const [{ data: cl }, { data: addon }] = await Promise.all([
        sb
          .from("clients")
          .select("id, display_name, organization_id")
          .eq("portal_token", data.token)
          .maybeSingle(),
        sb.from("addon_services").select("name").eq("id", data.addonServiceId).maybeSingle(),
      ]);
      if (cl?.organization_id) {
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager"], {
          orgId: cl.organization_id,
          type: "addon_request",
          title: `Add-on requested: ${(addon as any)?.name ?? "a service"}`,
          body: `${cl.display_name ?? "A client"} requested ${(addon as any)?.name ?? "an add-on"}${data.quantity > 1 ? ` ×${data.quantity}` : ""} from the portal`,
          link: `/clients/${cl.id}?tab=services`,
        });
      }
    } catch (e) {
      console.error("addon request in-app notification failed", (e as Error).message);
    }
    return { id: id as string };
  });

export const portalCancelAddon = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        addonSubscriptionId: z.string().uuid(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_cancel_addon", {
      _token: data.token,
      _addon_subscription_id: data.addonSubscriptionId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });

// ============ Saved cards + autopay ============

// Tenant->client card ops run on the org's own connected Stripe account.
async function loadStripe(orgId: string): Promise<{ stripe: any; stripeAccount: string }> {
  const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
  const acct = await requireOrgStripeAccount(orgId);
  const stripe = await connectStripe();
  return { stripe, stripeAccount: acct.accountId };
}

/** Inline (embedded) card save: create a SetupIntent on the connected account
 *  for a Payment Element, instead of redirecting to hosted Checkout. */
export const portalCreateSetupIntent = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", session.clientId)
      .single();
    if (!cRow) throw new Error("Client not found");

    const {
      requireOrgStripeAccount,
      connectStripe,
      connectPublishableKey,
      verifyClientStripeCustomer,
    } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(session.organizationId);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create(
        {
          email: cRow.primary_email ?? undefined,
          name: cRow.display_name ?? undefined,
          metadata: { client_id: cRow.id, organization_id: session.organizationId },
        },
        opts,
      );
      customerId = cust.id;
      await supabaseAdmin
        .from("clients")
        .update({ stripe_customer_id: customerId })
        .eq("id", cRow.id);
    }

    const si = await stripe.setupIntents.create(
      {
        customer: customerId,
        payment_method_types: ["card"],
        usage: "off_session",
        metadata: {
          client_id: cRow.id,
          organization_id: session.organizationId,
          source: "portal_setup_inline",
        },
      },
      opts,
    );
    return {
      clientSecret: si.client_secret as string,
      publishableKey: connectPublishableKey(),
      stripeAccount: acct.accountId,
    };
  });

/** Finalize an inline card save: mark the confirmed payment method as the
 *  client's default and record the card details. */
export const portalFinalizeCardSetup = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), setupIntentId: z.string().min(3) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { requireOrgStripeAccount, connectStripe } = await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(session.organizationId);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    const si = await stripe.setupIntents.retrieve(data.setupIntentId, {}, opts);
    const pmId = typeof si.payment_method === "string" ? si.payment_method : si.payment_method?.id;
    const customerId = typeof si.customer === "string" ? si.customer : si.customer?.id;
    if (!pmId || !customerId) throw new Error("Card wasn't saved. Please try again.");
    // Security (M2): the SetupIntent must be the one we minted for THIS client,
    // so a leaked/guessed seti_… id from another client can't bind their card here.
    if (si.metadata?.client_id !== session.clientId)
      throw new Error("Card setup could not be verified.");

    const pm = await stripe.paymentMethods.retrieve(pmId, {}, opts);
    await stripe.customers.update(
      customerId,
      { invoice_settings: { default_payment_method: pmId } },
      opts,
    );
    await supabaseAdmin
      .from("clients")
      .update({
        stripe_customer_id: customerId,
        default_payment_method_id: pmId,
        default_card_brand: pm.card?.brand ?? null,
        default_card_last4: pm.card?.last4 ?? null,
        // `autopay_enabled: true` was here, unconditionally, in the handler for a
        // button labelled "Save card".
        //
        // The portal offers autopay as a SEPARATE choice with its own button
        // ("Turn on autopay" / "Turn off autopay", portalSetAutopay) directly
        // above, under copy reading "Save a card for one-tap payments, OR enable
        // autopay". So a customer who had deliberately turned autopay off after a
        // surprise charge, and later replaced an expired card, had it switched
        // back on for them — and had no way to notice, because the toast says
        // "Card saved". The next nightly run charged them off-session.
        //
        // Staff had no remedy either: the client Billing tab only DISPLAYS the
        // flag, and the one staff mutation for it (resumeAutopay) turns it on.
        //
        // Omitted rather than set to false, so replacing a card leaves the
        // customer's own choice exactly as they left it, either way.
      })
      .eq("id", session.clientId);
    return { ok: true, brand: pm.card?.brand ?? null, last4: pm.card?.last4 ?? null };
  });

/** Toggle autopay preference. Requires a saved card to enable. */
export const portalSetAutopay = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), enabled: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { error } = await sb.rpc("portal_set_autopay", {
      _token: data.token,
      _enabled: data.enabled,
    });
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

/** Detach saved card, disable autopay. */
export const portalRemoveCard = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, default_payment_method_id")
      .eq("id", session.clientId)
      .single();
    if (cRow?.default_payment_method_id) {
      try {
        const { stripe, stripeAccount } = await loadStripe(session.organizationId);
        await stripe.paymentMethods.detach(cRow.default_payment_method_id, {}, { stripeAccount });
      } catch (e) {
        console.warn("detach pm failed", e);
      }
    }
    await supabaseAdmin
      .from("clients")
      .update({
        default_payment_method_id: null,
        default_card_brand: null,
        default_card_last4: null,
        autopay_enabled: false,
      })
      .eq("id", session.clientId);
    return { ok: true };
  });

/** Charge an open invoice off-session using the saved default card. */
export const portalPayInvoiceWithSavedCard = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), invoiceId: z.string().uuid() }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const supabaseAdmin = await admin();
    const { data: c } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, default_payment_method_id")
      .eq("id", session.clientId)
      .single();
    if (!c?.stripe_customer_id || !c.default_payment_method_id)
      throw new Error("No saved card on file");

    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select(
        "id, organization_id, client_id, total_cents, tax_cents, credit_applied_cents, amount_paid_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id",
      )
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== c.id) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Already paid");
    if (invoice.status === "void") throw new Error("Voided");
    // Charge what's still owed, net of applied credit (B7) — never the gross total.
    // Net the client's account credit off FIRST, which is what the comment
    // above this line has always claimed and what the code did not do.
    //
    // `invoiceOutstandingCents` is `total_cents - credit_applied_cents`, and
    // `credit_applied_cents` is only non-zero once `apply_credit_to_invoice`
    // has RUN. It is run by the staff invoice screen and by the nightly
    // autopay loop, and by neither portal charge path -- so the same invoice
    // cost one amount through the office and the gross amount through the
    // customer's own portal, while the header above the Pay button showed them
    // the credit balance it was about to ignore. PromoRedeemCard promises in
    // so many words that credit "is applied to your next invoice
    // automatically".
    //
    // Idempotent (advisory lock + row locks) and a no-op on anything but an
    // open invoice, so calling it here cannot double-apply. If the credit
    // covers the whole invoice it marks it paid and there is nothing to charge.
    // Never throws the customer out of a payment over it: on failure we fall
    // through to the last known figure, which can only ever be too HIGH by the
    // credit we failed to apply -- and that is the status quo, not a new fault.
    const { invoiceOutstandingCents } = await import("@/lib/ar");
    let dueCents = invoiceOutstandingCents(invoice);
    try {
      const { data: applied, error: applyErr } = await supabaseAdmin.rpc(
        "apply_credit_to_invoice",
        {
          _invoice_id: invoice.id,
        },
      );
      if (!applyErr && applied) {
        const a = applied as { remaining_due_cents?: number; invoice_status?: string };
        dueCents = Math.max(Number(a.remaining_due_cents ?? dueCents), 0);
        if (a.invoice_status === "paid" || dueCents <= 0) {
          throw new Error("Your account credit covered this invoice. Nothing left to pay.");
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Your account credit")) throw e;
      console.error("portal credit application failed", invoice.id, e);
    }
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // Stale-open guard: if a prior session/intent already paid this invoice
    // (webhook missed), reconcile instead of charging the saved card too.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Already paid");
      }
    }

    const { stripe, stripeAccount } = await loadStripe(invoice.organization_id);
    // In-flight bank debit guard (same rule as the staff charge path): a
    // stored PI in "processing" means the invoice IS being paid — charging
    // the saved card on top would collect twice when the debit clears. A
    // still-confirmable stale intent (e.g. an abandoned Payment Element at
    // the old amount) is canceled so it can't be confirmed after this charge.
    if (invoice.stripe_payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(
          invoice.stripe_payment_intent_id,
          {},
          { stripeAccount },
        );
        if (existing.status === "processing") {
          throw new Error(
            "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
          );
        }
        if (
          existing.status === "requires_payment_method" ||
          existing.status === "requires_confirmation" ||
          existing.status === "requires_action"
        ) {
          await stripe.paymentIntents.cancel(existing.id, {}, { stripeAccount });
        }
      } catch (e) {
        if ((e as Error).message?.startsWith("A payment for this invoice is already processing"))
          throw e;
        // Retrieve/cancel hiccups don't block the charge; the reconcile above ran.
      }
    }
    // Saved-card refs can be orphaned by a connected-account cutover; verify
    // before charging so the client gets "re-add your card" instead of a raw
    // "No such customer: 'cus_…'".
    const { verifyClientStripeCustomer } = await import("@/lib/stripe-connect.server");
    const liveCustomerId = await verifyClientStripeCustomer(stripe, stripeAccount, c);
    if (!liveCustomerId) {
      throw new Error("Your saved card is no longer on file. Please add a payment method again.");
    }
    // Saved card: the payment method is known before the charge is built, so
    // the rail and funding type are too and no second step is needed. The
    // platform fee stays on the BASE — we do not take 50 bps of a fee the
    // tenant is recovering from Stripe.
    const { orgFeeConfig, quoteForPaymentMethodId, surchargeMetadata } =
      await import("@/lib/processing-fee.server");
    const quote = await quoteForPaymentMethodId(stripe, {
      paymentMethodId: c.default_payment_method_id,
      stripeAccount,
      baseCents: dueCents,
      // The sales tax inside what is due is not surcharged (processing-fee.ts).
      taxCents: taxShareCents(dueCents, invoice.tax_cents, invoice.total_cents),
      config: await orgFeeConfig(supabaseAdmin, invoice.organization_id),
    });
    const { stayInvoicePaymentTypes } = await import("@/lib/stay-payment.server");
    const stayRails = await stayInvoicePaymentTypes(invoice.id, invoice.organization_id, []);
    try {
      const pi = await stripe.paymentIntents.create(
        {
          amount: quote.totalCents,
          application_fee_amount: platformFeeCents(dueCents, invoice),
          currency: invoice.currency ?? "usd",
          customer: c.stripe_customer_id,
          payment_method: c.default_payment_method_id,
          ...(stayRails.length ? { payment_method_types: stayRails } : {}),
          off_session: true,
          confirm: true,
          metadata: {
            invoice_id: invoice.id,
            organization_id: invoice.organization_id,
            source: "portal_saved_card",
            ...surchargeMetadata(quote),
          },
        },
        {
          // Prevent a double-tap (or a retried request) from charging twice.
          // The amount is in the key so a changed balance (credit applied)
          // mints fresh; the payment-method id is in the key because after a
          // decline the client may save a NEW card the same day, and replaying
          // the old key with different params would be an idempotency_error.
          // It is the CHARGED total, not the invoice base: a tenant who switches
          // pass-through on between two attempts changes the amount, and reusing
          // the key would be exactly that idempotency_error.
          idempotencyKey: `portal-saved-card-${invoice.id}-${quote.totalCents}-${c.default_payment_method_id}`,
          stripeAccount,
        },
      );
      await supabaseAdmin
        .from("invoices")
        .update({
          stripe_payment_intent_id: pi.id,
          status: "open",
        })
        .eq("id", invoice.id);
      await supabaseAdmin
        .from("clients")
        .update({
          autopay_last_attempt_at: new Date().toISOString(),
          autopay_last_error: null,
        })
        .eq("id", c.id);
      return { ok: true, status: pi.status };
    } catch (e) {
      const msg = (e as Error).message || "Card charge failed";
      await supabaseAdmin
        .from("clients")
        .update({
          autopay_last_attempt_at: new Date().toISOString(),
          autopay_last_error: msg,
        })
        .eq("id", c.id);
      throw new Error(msg);
    }
  });

// ── Portal: history, dogs, concerns, photo signing ──────────────────────────

/** The service line of each of these visits, for the session's own client.
 *  A visit that is not theirs, or a read that fails, is simply absent. */
async function serviceLinesOf(
  sb: any,
  session: { clientId: string; organizationId: string },
  visitIds: string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (visitIds.length === 0) return out;
  try {
    const { data } = await sb
      .from("visits")
      .select("id, services(service_line)")
      .in("id", visitIds)
      .eq("client_id", session.clientId)
      .eq("organization_id", session.organizationId);
    for (const v of (Array.isArray(data) ? data : []) as Array<{ id: string; services: any }>) {
      const svc = Array.isArray(v.services) ? v.services[0] : v.services;
      out.set(v.id, (svc?.service_line as string | null | undefined) ?? null);
    }
  } catch (e) {
    console.warn("portal could not read visit service lines", (e as Error).message);
  }
  return out;
}

/** Whether this visit of the session's client is a dog walk (#410). Throws
 *  when it cannot tell, so a refusal that depends on it cannot be skipped by
 *  a failed read. A visit that is not the client's is not a walk here; the
 *  RPC refuses it on its own. */
async function visitIsWalk(
  sb: any,
  session: { clientId: string; organizationId: string },
  visitId: string | null,
): Promise<boolean> {
  if (!visitId) return false;
  const { data, error } = await sb
    .from("visits")
    .select("id, services(service_line)")
    .eq("id", visitId)
    .eq("client_id", session.clientId)
    .eq("organization_id", session.organizationId)
    .maybeSingle();
  if (error) throw new Error("We couldn't check that visit. Please try again.");
  const svc = Array.isArray(data?.services) ? data.services[0] : data?.services;
  return isWalkLine(svc?.service_line);
}

export const portalListRecentVisits = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalRecentVisits(data.token, session);
  });

async function loadPortalRecentVisits(token: string, session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_recent_visits", { _token: token });
  if (error) throw new Error(error.message);
  const list = (rows ?? []) as Array<Record<string, any> & { visit_id: string }>;
  // Which rows are dog walks (#410): a walk is offered no re-clean and no
  // yard options, and reads in walk words. The RPC does not return it.
  const lines = await serviceLinesOf(
    sb,
    session,
    list.map((r) => r.visit_id),
  );
  return list.map((r) => ({ ...r, service_line: lines.get(r.visit_id) ?? null })) as Array<{
    visit_id: string;
    scheduled_on: string;
    status: string;
    photo_paths: string[];
    // Parallel to photo_paths, same order, added in 20260903130000. The page
    // used to label a photo by its INDEX -- `i % 2 === 0 ? "Before" :
    // "After"` -- because position was all it had.
    photo_kinds: string[];
    tech_name: string | null;
    // When the visit was finished. The re-clean window is measured from
    // this, not from scheduled_on.
    completed_at: string | null;
    // Free text a technician typed at the gate, and the structured reason
    // beside it. The page shows the code; see portal-ui.tsx for why the text
    // is shown only when the customer wrote it.
    skip_reason: string | null;
    skip_reason_code: string | null;
    // The visit's service line, or null when it could not be read. A walk
    // is "dog_walking".
    service_line: string | null;
  }>;
}

export const portalListDogs = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalDogs(data.token, session);
  });

async function loadPortalDogs(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_dogs", { _token: token });
  if (error) throw new Error(error.message);
  return (rows ?? []) as Array<{
    dog_id: string;
    name: string;
    breed: string | null;
    weight_class: string | null;
    temperament: string | null;
    notes: string | null;
  }>;
}

export const portalReportConcern = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        visitId: z.string().uuid().nullable(),
        // The yard categories, and the walk issues (#410), which are stored
        // as yard categories with the issue in the message. See
        // walk-concerns.ts.
        category: z.enum([
          "missed_spot",
          "gate_left_open",
          "damage",
          "wrong_yard",
          "other",
          ...WALK_ISSUE_CODES,
        ]),
        message: z.string().max(1000).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    // A walk is not a yard: the portal does not offer these on a walk, and
    // a request that sends one anyway is refused.
    if (
      (YARD_ONLY_CONCERNS as readonly string[]).includes(data.category) &&
      (await visitIsWalk(sb, session, data.visitId))
    ) {
      throw new Error("That option is for a yard visit. Pick one that fits the walk.");
    }
    const row = isWalkIssue(data.category)
      ? walkConcernRow(data.category, data.message)
      : { category: data.category, message: data.message };
    const { data: id, error } = await sb.rpc("portal_report_concern", {
      _token: data.token,
      _visit_id: data.visitId as string,
      _category: row.category,
      _message: row.message,
    });
    if (error) throw new Error(error.message);

    // Notify the office by email (finding #14): a dashboard banner alone isn't
    // reliable for something that could be a safety/liability issue like a gate
    // left open. Best-effort — never block the client's submission.
    try {
      await notifyOfficeOfConcern(sb, data.token, data.category, data.message);
    } catch (e) {
      console.error("concern office notification failed", (e as Error).message);
    }
    // In-app notification to owners/managers (concern could be a safety issue).
    try {
      const { data: cl } = await sb
        .from("clients")
        .select("display_name, organization_id")
        .eq("portal_token", data.token)
        .maybeSingle();
      if (cl?.organization_id) {
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager"], {
          orgId: cl.organization_id,
          type: "concern",
          title: `New concern: ${concernLabel(data.category) ?? "Concern"}`,
          body: `${cl.display_name ?? "A client"}${data.message ? `: ${data.message.slice(0, 120)}` : ""}`,
          link: "/concerns",
        });
      }
    } catch (e) {
      console.error("concern in-app notification failed", (e as Error).message);
    }
    return { ticketId: id as string };
  });

/**
 * The customer asks for the free re-clean the business guarantees.
 *
 * Same shape as portalReportConcern on purpose: the session check first, then
 * the RPC as service_role, which resolves the client from the token itself and
 * refuses anything outside the org's window. The office hears about it the
 * same two ways a concern reaches them — email and the in-app bell — worded as
 * a re-clean request, because "New client concern" on something the business
 * has promised to do for free undersells how quickly it needs doing.
 *
 * Idempotent in the database: a second tap returns the first ticket, and the
 * office is only notified when the ticket is new.
 */
export const portalRequestReclean = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        visitId: z.string().uuid(),
        message: z.string().max(1000).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();

    // The guarantee is for pet waste. A walk is refused here, before
    // anything is written, so a request sent past the portal is refused too.
    if (await visitIsWalk(sb, session, data.visitId)) {
      const { recleanRefusalMessage } = await import("@/lib/reclean");
      throw new Error(recleanRefusalMessage("visit_is_a_walk"));
    }

    // Was there already an open request? Asked before the RPC so the office
    // is not told twice about one request.
    const { data: existing } = await sb
      .from("qc_tickets")
      .select("id")
      .eq("visit_id", data.visitId)
      .eq("category", "reclean_request")
      .neq("status", "resolved")
      .maybeSingle();

    const { data: id, error } = await sb.rpc("portal_request_reclean", {
      _token: data.token,
      _visit_id: data.visitId,
      _message: data.message,
    });
    if (error) {
      const { recleanRefusalMessage } = await import("@/lib/reclean");
      throw new Error(recleanRefusalMessage(error.message));
    }
    const ticketId = id as string;
    const alreadyAsked = !!existing && existing.id === ticketId;
    if (alreadyAsked) return { ticketId, alreadyAsked };

    const { data: visit } = await sb
      .from("visits")
      .select("scheduled_on")
      .eq("id", data.visitId)
      .maybeSingle();
    // "Mon, Sep 28": scheduled_on is a DATE, so no zone can move it.
    const visitDay = visit?.scheduled_on ? formatDay(visit.scheduled_on) : null;

    try {
      await notifyOfficeOfConcern(sb, data.token, "reclean_request", data.message, visitDay);
    } catch (e) {
      console.error("reclean office notification failed", (e as Error).message);
    }
    try {
      const { data: cl } = await sb
        .from("clients")
        .select("display_name, organization_id")
        .eq("portal_token", data.token)
        .maybeSingle();
      if (cl?.organization_id) {
        const { notifyRoles } = await import("@/lib/notify-center.server");
        await notifyRoles(["owner", "office_manager"], {
          orgId: cl.organization_id,
          type: "concern",
          title: `Re-clean requested: ${cl.display_name ?? "a client"}`,
          body: `${visitDay ? `For the visit on ${visitDay}` : "For a recent visit"}${
            data.message ? `: ${data.message.slice(0, 120)}` : ""
          }`,
          link: "/concerns",
        });
      }
    } catch (e) {
      console.error("reclean in-app notification failed", (e as Error).message);
    }
    return { ticketId, alreadyAsked };
  });

/**
 * What the portal needs to offer an extra cleanup: the days that can be
 * asked for, the customer's own addresses, and whether it will be booked at
 * once or wait for the office.
 *
 * The days are computed with bookableDays (src/lib/one-off-booking.ts), which
 * restates portal_request_one_off's rules against the same columns -- the
 * org's timezone, work_days and blackout_dates -- so the list and the refusal
 * cannot disagree about which setting they read.
 */
export const portalOneOffBookingOptions = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    const sb = await admin();
    const { data: org } = await (sb.from("organizations") as any)
      .select(
        "timezone, work_days, portal_auto_accept_bookings, one_off_price_cents, currency, workday_start, workday_end",
      )
      .eq("id", session.organizationId)
      .maybeSingle();
    const tz = (org?.timezone as string | null) || "America/Chicago";
    const { walkWindows } = await import("@/lib/walk-windows");
    const today = orgToday(tz);
    const { addDaysToDay } = await import("@/lib/reclean");
    const { bookableDays, ONE_OFF_MAX_DAYS_AHEAD, oneOffServiceOptions } = await import(
      "@/lib/one-off-booking"
    );
    const { loadServiceLineAvailability } = await import("@/lib/service-line-availability.server");
    const [{ data: blackouts }, { data: props }, { data: services }, { data: client }, availability] = await Promise.all([
      sb
        .from("blackout_dates")
        .select("blackout_on")
        .eq("organization_id", session.organizationId)
        .gt("blackout_on", today)
        .lte("blackout_on", addDaysToDay(today, ONE_OFF_MAX_DAYS_AHEAD)),
      (sb.from("properties") as any)
        .select("id, label, street, city")
        .eq("client_id", session.clientId)
        .is("archived_at", null)
        .order("created_at"),
      // The business's services (phase 5): what the card lists. The service
      // role reads them; a customer has no row in services' RLS.
      (sb.from("services") as any)
        .select(
          "id, name, service_line, active, price_unit, base_price_cents, extra_pet_cents, default_duration_min",
        )
        .eq("organization_id", session.organizationId)
        .eq("active", true),
      (sb.from("clients") as any)
        .select("account_type")
        .eq("id", session.clientId)
        .maybeSingle(),
      loadServiceLineAvailability(),
    ]);
    const priceCents = (org?.one_off_price_cents as number | null) ?? null;
    // The pets at each address, counted exactly as bookOneOffVisit counts them
    // when it prices the booking (active dogs, NOT (active IS false), at least
    // one; a commercial account prices as one), so the price the card shows
    // before the tap is the price that is charged.
    const propertyIds = ((props ?? []) as Array<{ id: string }>).map((p) => p.id);
    const commercial = (client?.account_type as string | null) === "commercial";
    const petsByProperty: Record<string, number> = Object.fromEntries(propertyIds.map((id) => [id, 1]));
    if (!commercial && propertyIds.length > 0) {
      const { data: dogs } = await (sb.from("dogs") as any)
        .select("property_id")
        .in("property_id", propertyIds)
        .not("active", "is", false)
        .eq("species", "dog");
      for (const d of (dogs ?? []) as Array<{ property_id: string }>) {
        if (d.property_id in petsByProperty) petsByProperty[d.property_id] += 1;
      }
      for (const id of propertyIds) petsByProperty[id] = Math.max(1, petsByProperty[id] - 1);
    }
    return {
      today,
      days: bookableDays(
        today,
        (org?.work_days as number[] | null) ?? null,
        (blackouts ?? []).map((b: { blackout_on: string }) => b.blackout_on),
      ),
      properties: (props ?? []) as Array<{
        id: string;
        label: string | null;
        street: string;
        city: string | null;
      }>,
      // Auto-accept books at the chosen service's price (the org's one-off
      // price for pet waste), so a service without one cannot be booked
      // automatically and the request waits for the office. The card reads
      // this beside each service's own priceCents.
      autoAccept: !!org?.portal_auto_accept_bookings,
      /** The extra cleanup's price: what the card showed before services. */
      priceCents,
      // The pet-waste service at the one-off price, and every other active,
      // priced service at its own (one pet). Empty for a business with no
      // active service, when the card offers the extra cleanup as before.
      services: oneOffServiceOptions(
        ((services ?? []) as any[]).filter((s) => s.service_line !== "mobile_grooming"),
        priceCents,
        availability,
      ),
      petsByProperty,
      currency: ((org?.currency as string | null) ?? "usd").toLowerCase(),
      // The times a walk can be asked for (#410): the working day in two-hour
      // windows. portalRequestOneOff accepts only these, or no window.
      walkWindows: walkWindows(org?.workday_start ?? null, org?.workday_end ?? null),
    };
  });

/**
 * The customer asks for an extra cleanup on a day of their choosing.
 *
 * Same shape as portalRequestReclean: the session check, then the RPC as
 * service_role, which resolves the client from the token itself and refuses
 * anything outside the rules. Idempotent in the database -- a second tap
 * returns the first request with created = false -- and only the call that
 * CREATED the request books it (when the owner turned auto-accept on) or
 * tells the office, so a double tap is one request, one visit, one email.
 *
 * Auto-accept books through bookOneOffVisit, the code behind the office's
 * createOneOffVisit, at the org's one-off price. If that booking fails (a
 * hold on the client, say) the request simply stays open for the office.
 */
export const portalRequestOneOff = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        propertyId: z.string().uuid(),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        message: z.string().max(1000).optional().default(""),
        /** The service asked for (phase 5). Omitted: the extra cleanup, as
         *  every request before the catalog. */
        serviceId: z.string().uuid().optional(),
        /** A walk's time window (#410), "HH:MM". Both or neither, and only
         *  one of the windows portalOneOffBookingOptions offered. */
        earliestTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        latestTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();

    // The service, when one was named: the database refuses another
    // business's or a deactivated one (service_not_offered); this read is for
    // the words and the price. Pet waste is the extra cleanup, as before.
    let service: {
      id: string;
      name: string;
      service_line: string;
      base_price_cents: number | null;
    } | null = null;
    if (data.serviceId) {
      const { data: svc } = await (sb.from("services") as any)
        .select("id, name, service_line, base_price_cents")
        .eq("id", data.serviceId)
        .eq("organization_id", session.organizationId)
        .maybeSingle();
      service = svc ?? null;
      // A line that is still Coming soon is never offered (oneOffServiceOptions),
      // so a request that names one anyway is refused here, before anything
      // is saved (#506). The RPC refuses it too; this is the plain sentence.
      // The platform switch, read at runtime (#531).
      // A service with no price yet is not offered either (oneOffServiceOptions
      // leaves it out), now that a walk can be bookable (#530).
      const [{ isBookableLine }, { loadServiceLineAvailability }] = await Promise.all([
        import("@/lib/service-lines"),
        import("@/lib/service-line-availability.server"),
      ]);
      if (
        service &&
        (!isBookableLine(service.service_line, await loadServiceLineAvailability()) ||
          (service.service_line !== "pet_waste" && service.base_price_cents == null))
      ) {
        const { oneOffRefusalMessage } = await import("@/lib/one-off-booking");
        throw new Error(oneOffRefusalMessage("service_not_offered"));
      }
    }
    if (service?.service_line === "mobile_grooming") {
      throw new Error("Mobile grooming is booked by the office.");
    }
    const petWaste = !service || service.service_line === "pet_waste";
    // A walk's window: one the card offered, or none. Refused before anything
    // is saved, in plain words.
    const { checkedWalkWindow, recordRequestedWindow } = await import("@/lib/walk-request.server");
    const walkWindow = await checkedWalkWindow(sb, session.organizationId, service, data);

    const { data: rows, error } = await (sb as any).rpc("portal_request_one_off", {
      _token: data.token,
      _property_id: data.propertyId,
      _on: data.day,
      _message: data.message,
      ...(data.serviceId ? { _service_id: data.serviceId } : {}),
    });
    if (error) {
      const { oneOffRefusalMessage } = await import("@/lib/one-off-booking");
      throw new Error(oneOffRefusalMessage(error.message));
    }
    const row = ((rows ?? []) as Array<{ ticket_id: string; created: boolean }>)[0];
    if (!row?.ticket_id) throw new Error("That request couldn't be saved. Please try again.");
    const ticketId = row.ticket_id;

    if (!row.created) {
      // Asked already. Say what became of it, and tell nobody again.
      const { data: t } = await (sb.from("qc_tickets") as any)
        .select("booked_visit:visits!qc_tickets_booked_visit_id_fkey(scheduled_on)")
        .eq("id", ticketId)
        .maybeSingle();
      const bv = Array.isArray(t?.booked_visit) ? t.booked_visit[0] : t?.booked_visit;
      return { ticketId, alreadyAsked: true, bookedOn: (bv?.scheduled_on as string) ?? null };
    }

    // The window rides on the request, so the inbox shows it and the office's
    // Book it carries it.
    if (walkWindow) await recordRequestedWindow(sb, session.organizationId, ticketId, walkWindow);
    const dayLabel = walkWindow
      ? `${formatDay(data.day)}, ${walkWindow.label}`
      : formatDay(data.day);
    let bookedOn: string | null = null;
    const { data: org } = await (sb.from("organizations") as any)
      .select("portal_auto_accept_bookings, one_off_price_cents")
      .eq("id", session.organizationId)
      .maybeSingle();
    // The extra cleanup books at the org's one-off price, as it always has; a
    // walk books at its service's price, worked out for the property's pets
    // by bookOneOffVisit through the one rule. Neither books without a price.
    const canAutoBook = petWaste ? org?.one_off_price_cents != null : true;
    if (org?.portal_auto_accept_bookings && canAutoBook) {
      try {
        const { bookOneOffVisit } = await import("@/lib/one-off-visit.server");
        const { oneOffVisitNote } = await import("@/lib/one-off-booking");
        const booked = await bookOneOffVisit(sb, {
          orgId: session.organizationId,
          actorUserId: null,
          clientId: session.clientId,
          propertyId: data.propertyId,
          scheduledOn: data.day,
          priceCents: petWaste ? Number(org.one_off_price_cents) : "service",
          serviceId: service?.id ?? null,
          note: oneOffVisitNote(dayLabel, true, petWaste ? null : service?.name),
          asService: true,
          earliestTime: walkWindow?.earliest ?? null,
          latestTime: walkWindow?.latest ?? null,
        });
        const { data: linked } = await (sb.from("qc_tickets") as any)
          .update({
            booked_visit_id: booked.visitId,
            status: "resolved",
            resolved_at: new Date().toISOString(),
            resolution_note: `Booked for ${formatDay(booked.scheduledOn)}.`,
          })
          .eq("id", ticketId)
          .eq("organization_id", session.organizationId)
          .select("id");
        if (!linked || linked.length === 0) {
          console.error("one-off auto-accept booked a visit it could not link", ticketId);
        }
        bookedOn = booked.scheduledOn;
      } catch (e) {
        // Not the customer's problem: the request is saved and the office
        // will book it by hand.
        console.error("one-off auto-accept failed; left for the office", (e as Error).message);
      }
    }

    const { oneOffRequestWord } = await import("@/lib/one-off-booking");
    const word = oneOffRequestWord(service);
    try {
      await notifyOfficeOfConcern(
        sb,
        data.token,
        "one_off_request",
        data.message,
        dayLabel,
        bookedOn != null,
        word,
      );
    } catch (e) {
      console.error("one-off office notification failed", (e as Error).message);
    }
    try {
      const { data: cl } = await sb
        .from("clients")
        .select("display_name")
        .eq("id", session.clientId)
        .maybeSingle();
      const { notifyRoles } = await import("@/lib/notify-center.server");
      await notifyRoles(["owner", "office_manager"], {
        orgId: session.organizationId,
        type: "concern",
        title: `${word} ${bookedOn ? "booked" : "requested"}: ${cl?.display_name ?? "a client"}`,
        body: `For ${dayLabel}${data.message ? `: ${data.message.slice(0, 120)}` : ""}`,
        link: "/concerns",
      });
    } catch (e) {
      console.error("one-off in-app notification failed", (e as Error).message);
    }
    return { ticketId, alreadyAsked: false, bookedOn };
  });

const CONCERN_LABELS: Record<string, string> = {
  missed_spot: "Missed spot",
  gate_left_open: "Gate left open",
  damage: "Property damage",
  wrong_yard: "Wrong yard",
  other: "Other",
  reclean_request: "Re-clean request",
  one_off_request: "Extra cleanup request",
};

/** The office's words for a category, or for a walk issue (#410). */
function concernLabel(category: string): string | undefined {
  return isWalkIssue(category) ? `Walk: ${WALK_ISSUE_LABELS.en[category]}` : CONCERN_LABELS[category];
}

/** Exported for the groom request (portal-groom.server.ts) and the training
 *  lesson request (portal-training.functions.ts), which tell the office the
 *  same way a one-off request does. */
export async function notifyOfficeOfConcern(
  sb: any,
  token: string,
  category: string,
  message: string,
  /** The visit's day, for a re-clean request: the office needs to know WHICH
   *  visit the guarantee is being called on before they open anything. */
  visitDay: string | null = null,
  /** A one-off request that auto-accept already booked. */
  booked = false,
  /** What a one-off request was for: "Extra cleanup", or the service's name
   *  when the customer asked for something else the business sells. */
  oneOffWord = "Extra cleanup",
): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  if (!resendApiKey) return; // email not configured — banner + inbox still work
  const { data: client } = await sb
    .from("clients")
    .select("display_name, organization_id, organizations(name, contact_email)")
    .eq("portal_token", token)
    .maybeSingle();
  if (!client) return;
  const org: any = Array.isArray(client.organizations)
    ? client.organizations[0]
    : client.organizations;
  const to = org?.contact_email;
  if (!to) return; // no office inbox on file

  const label = concernLabel(category) ?? category;
  const isReclean = category === "reclean_request";
  // For a one-off request `visitDay` is the day the customer ASKED for, and
  // `booked` says whether auto-accept already put it on the schedule.
  const isOneOff = category === "one_off_request";
  const crypto = await import("node:crypto");
  const messageId = `concern-${crypto.randomBytes(8).toString("hex")}`;
  const subject = isReclean
    ? `Re-clean requested by ${client.display_name}`
    : isOneOff
      ? `${oneOffWord} ${booked ? "booked" : "requested"} by ${client.display_name}`
      : `New client concern: ${label}`;
  const html =
    (isReclean
      ? `<p><strong>Re-clean requested</strong> under your re-clean guarantee${
          visitDay ? ` for the visit on ${visitDay}` : ""
        }.</p>`
      : isOneOff
        ? `<p><strong>${oneOffWord} ${booked ? "booked" : "requested"}</strong>${
            visitDay ? ` for ${visitDay}` : ""
          }${booked ? ", automatically, at its price." : "."}</p>`
        : `<p><strong>New client concern:</strong> ${label}</p>`) +
    `<p>From: ${client.display_name}</p>` +
    (message ? `<p>${message.replace(/</g, "&lt;")}</p>` : "") +
    `<p><a href="${appUrl("/concerns")}">Open the Concerns inbox</a>${
      isReclean ? " to schedule it" : isOneOff && !booked ? " to book or decline it" : ""
    }</p>`;
  const text = isReclean
    ? `Re-clean requested by ${client.display_name}${visitDay ? ` for the visit on ${visitDay}` : ""}. ${message}`.trim()
    : isOneOff
      ? `${oneOffWord} ${booked ? "booked" : "requested"} by ${client.display_name}${visitDay ? ` for ${visitDay}` : ""}. ${message}`.trim()
      : `New client concern (${label}) from ${client.display_name}. ${message}`.trim();
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": messageId,
    },
    body: JSON.stringify({
      from: `${org?.name ?? "HoundStack"} <noreply@notify.houndstack.com>`,
      to: [to],
      subject,
      html,
      text,
    }),
  });
  const status = res.ok ? "sent" : "failed";
  await sb
    .from("email_send_log")
    .insert({
      message_id: messageId,
      template_name: "concern-notification",
      recipient_email: to,
      status,
      error_message: res.ok ? null : `Resend ${res.status}`,
    })
    .then(
      () => {},
      () => {},
    );
}

export const portalSignPhotoUrls = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), paths: z.array(z.string()).max(60) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    if (data.paths.length === 0) return { urls: {} as Record<string, string> };
    const supabaseAdmin = await admin();
    // Only sign photos that belong to this client's own visits — never sign an
    // arbitrary caller-supplied storage path.
    const { data: ownRows, error: ownErr } = await supabaseAdmin.rpc("portal_list_recent_visits", {
      _token: data.token,
    });
    if (ownErr) throw new Error(ownErr.message);
    const allowed = new Set<string>();
    for (const r of (ownRows ?? []) as Array<{ photo_paths: string[] }>) {
      for (const p of r.photo_paths ?? []) allowed.add(p);
    }
    const safePaths = data.paths.filter((p) => allowed.has(p));
    if (safePaths.length === 0) return { urls: {} as Record<string, string> };
    const { data: signed, error } = await supabaseAdmin.storage
      .from("visit-photos")
      .createSignedUrls(safePaths, 600);
    if (error) throw new Error(error.message);
    const urls: Record<string, string> = {};
    for (const s of signed ?? []) if (s.path && s.signedUrl) urls[s.path] = s.signedUrl;
    void session;
    return { urls };
  });

export const portalGetReferral = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalReferral(data.token, session);
  });

async function loadPortalReferral(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_get_referral", { _token: token });
  if (error) throw new Error(error.message);
  return (rows?.[0] ?? { referral_code: null }) as { referral_code: string | null };
}

// ── Portal: stations, requests, vacation hold, promo redemption ─────────────

export const portalListStations = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalStations(data.token, session);
  });

async function loadPortalStations(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_stations" as any, {
    _token: token,
  });
  if (error) throw new Error(error.message);
  return (rows ?? []) as Array<{
    station_id: string;
    station_number: number | null;
    label: string | null;
    location_description: string | null;
    liner_size: string | null;
    last_serviced_on: string | null;
  }>;
}

export const portalListMyRequests = createServerFn({ method: "GET" })
  .inputValidator((d) => tokenSchema.parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token, { readOnly: true });
    return loadPortalMyRequests(data.token, session);
  });

async function loadPortalMyRequests(token: string, _session: PortalSession) {
  const sb = await admin();
  const { data: rows, error } = await sb.rpc("portal_list_my_requests" as any, {
    _token: token,
  });
  if (error) throw new Error(error.message);
  return (rows ?? []) as Array<{
    ticket_id: string;
    visit_id: string | null;
    visit_date: string | null;
    category: string;
    message: string | null;
    status: string;
    resolution_note: string | null;
    resolved_at: string | null;
    created_at: string;
    /** For a one-off request: the day asked for, and the day booked. */
    requested_on: string | null;
    booked_on: string | null;
    /** The service a one-off request named ("30-minute walk"); null for
     *  the extra cleanup and for every other kind of request. */
    service_name: string | null;
  }>;
}

export const portalRequestVacationHold = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        reason: z.string().max(500).optional().default(""),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();
    // With auto-apply on, a hold skips every visit in the range outright, and
    // the first of them can be on a tech's today or tomorrow. The watch only
    // looks at those two days, so it needs only the EARLIEST of this client's
    // open visits in the range: twenty is several weeks of the busiest plan.
    const { data: inRange } = await sb
      .from("visits")
      .select("id")
      .eq("organization_id", session.organizationId)
      .eq("client_id", session.clientId)
      .gte("scheduled_on", data.startDate)
      .lte("scheduled_on", data.endDate)
      .in("status", ["scheduled", "in_progress"])
      .order("scheduled_on", { ascending: true })
      .limit(20);
    const visitIds = ((inRange ?? []) as Array<{ id: string }>).map((v) => v.id);
    const { startRouteWatch } = await import("@/lib/field-notify.server");
    const watch = await startRouteWatch({
      actorUserId: null,
      orgId: session.organizationId,
      visitIds,
    });
    const { watchRouteLiveActivities } = await import("@/lib/push-liveactivity.server");
    const pushRoutes = await watchRouteLiveActivities(visitIds);
    const { data: n, error } = await sb.rpc("portal_request_vacation_hold" as any, {
      _token: data.token,
      _start: data.startDate,
      _end: data.endDate,
      _reason: data.reason,
    });
    if (error) throw new Error(error.message);
    await watch.finish();
    await pushRoutes();
    return { skippedCount: (n as number) ?? 0 };
  });

export const portalRedeemPromo = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z.object({ token: z.string().uuid(), code: z.string().min(2).max(60) }).parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    await requirePortalSession(data.token);
    const sb = await admin();
    const { data: amt, error } = await sb.rpc("portal_redeem_promo" as any, {
      _token: data.token,
      _code: data.code,
    });
    if (error) throw new Error(error.message);
    return { creditCents: (amt as number) ?? 0 };
  });

// ── In-app Payment Element (inline card/ACH) ───────────────────────────────

// Explicit payment method types keep the Payment Element to card + ACH — no
// Klarna/Affirm/Cash App clutter from automatic payment methods.
const INVOICE_PM_TYPES = ["card", "us_bank_account"];

// ACH requires activation on the connected account; when it isn't enabled the
// PI create/update fails and we retry card-only.
function isBankDebitUnavailableError(e: unknown): boolean {
  const err = e as { message?: string; param?: string };
  return (
    /us_bank_account/i.test(err?.message ?? "") || /payment_method_types/.test(err?.param ?? "")
  );
}

export const portalCreateInvoicePaymentIntent = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        invoiceId: z.string().uuid(),
        // The payer's tip CHOICE, never an amount. See src/lib/tips.ts.
        tip: tipChoiceSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    // Connect direct charges: the client-side Payment Element initializes with
    // the platform publishable key scoped to the org's connected account.
    const publishableKey = process.env.STRIPE_CONNECT_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error("Payments not configured");

    const supabaseAdmin = await admin();
    const { data: invoice, error: iErr } = await supabaseAdmin
      .from("invoices")
      .select(
        "id, number, organization_id, client_id, total_cents, tax_cents, credit_applied_cents, amount_paid_cents, currency, status, stripe_payment_intent_id, stripe_checkout_session_id",
      )
      .eq("id", data.invoiceId)
      .single();
    if (iErr) throw new Error(iErr.message);
    if (invoice.client_id !== session.clientId) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    const { stayInvoicePaymentTypes } = await import("@/lib/stay-payment.server");
    const paymentMethodTypes = await stayInvoicePaymentTypes(invoice.id, invoice.organization_id, INVOICE_PM_TYPES);
    // Charge what's still owed, net of applied credit (B7) — never the gross total.
    // Net the client's account credit off FIRST, which is what the comment
    // above this line has always claimed and what the code did not do.
    //
    // `invoiceOutstandingCents` is `total_cents - credit_applied_cents`, and
    // `credit_applied_cents` is only non-zero once `apply_credit_to_invoice`
    // has RUN. It is run by the staff invoice screen and by the nightly
    // autopay loop, and by neither portal charge path -- so the same invoice
    // cost one amount through the office and the gross amount through the
    // customer's own portal, while the header above the Pay button showed them
    // the credit balance it was about to ignore. PromoRedeemCard promises in
    // so many words that credit "is applied to your next invoice
    // automatically".
    //
    // Idempotent (advisory lock + row locks) and a no-op on anything but an
    // open invoice, so calling it here cannot double-apply. If the credit
    // covers the whole invoice it marks it paid and there is nothing to charge.
    // Never throws the customer out of a payment over it: on failure we fall
    // through to the last known figure, which can only ever be too HIGH by the
    // credit we failed to apply -- and that is the status quo, not a new fault.
    const { invoiceOutstandingCents } = await import("@/lib/ar");
    let dueCents = invoiceOutstandingCents(invoice);
    try {
      const { data: applied, error: applyErr } = await supabaseAdmin.rpc(
        "apply_credit_to_invoice",
        {
          _invoice_id: invoice.id,
        },
      );
      if (!applyErr && applied) {
        const a = applied as { remaining_due_cents?: number; invoice_status?: string };
        dueCents = Math.max(Number(a.remaining_due_cents ?? dueCents), 0);
        if (a.invoice_status === "paid" || dueCents <= 0) {
          throw new Error("Your account credit covered this invoice. Nothing left to pay.");
        }
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("Your account credit")) throw e;
      console.error("portal credit application failed", invoice.id, e);
    }
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // The tip is decided here, against the amount due as it stands AFTER the
    // credit above, from the payer's choice alone -- the same function the
    // public pay link uses, so the two screens cannot charge differently.
    const { data: tipOrg } = await supabaseAdmin
      .from("organizations")
      .select("tips_enabled")
      .eq("id", invoice.organization_id)
      .maybeSingle();
    const tipsEnabled = !!(tipOrg as { tips_enabled?: boolean | null } | null)?.tips_enabled;
    const charge = tippedCharge({ dueCents, choice: data.tip, tipsEnabled, invoice });
    // If the stored intent OR a legacy hosted-checkout session already
    // succeeded but the status is stale (webhook missed), reconcile instead
    // of minting a new intent and charging the client a second time.
    if (invoice.stripe_payment_intent_id || invoice.stripe_checkout_session_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", session.clientId)
      .single();
    if (!cRow) throw new Error("Client not found");

    const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } =
      await import("@/lib/stripe-connect.server");
    const acct = await requireOrgStripeAccount(invoice.organization_id);
    const stripe = await connectStripe();
    const opts = { stripeAccount: acct.accountId };

    let customerId = await verifyClientStripeCustomer(stripe, acct.accountId, cRow);
    if (!customerId) {
      const cust = await stripe.customers.create(
        {
          email: cRow.primary_email ?? undefined,
          name: cRow.display_name ?? undefined,
          metadata: { client_id: cRow.id, organization_id: invoice.organization_id },
        },
        opts,
      );
      customerId = cust.id;
      await supabaseAdmin
        .from("clients")
        .update({ stripe_customer_id: customerId })
        .eq("id", cRow.id);
    }

    const currency = (invoice.currency ?? "usd").toLowerCase();
    const metadata = {
      invoice_id: invoice.id,
      organization_id: invoice.organization_id,
      source: "portal_inline",
      // Always written, "0" included: Stripe merges metadata on update.
      ...charge.metadata,
    };

    let pi: import("stripe").Stripe.PaymentIntent | null = null;
    if (invoice.stripe_payment_intent_id) {
      try {
        const existing = await stripe.paymentIntents.retrieve(
          invoice.stripe_payment_intent_id,
          {},
          opts,
        );
        // An in-flight bank debit means the invoice IS being paid; minting a
        // replacement intent here would lose the reference and invite a
        // second charge while the debit clears.
        if (existing.status === "processing") {
          throw new Error(
            "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
          );
        }
        if (
          existing.status === "requires_payment_method" ||
          existing.status === "requires_confirmation" ||
          existing.status === "requires_action"
        ) {
          // Always update the reused intent: syncs amount/currency, pins
          // explicit payment_method_types so previously-minted "automatic"
          // intents stop offering Klarna/Affirm/etc., and (re)sets
          // setup_future_usage — a staff-minted intent doesn't save the card,
          // but the client paying it themselves consents to saving theirs.
          const updateParams = {
            // Invoice + tip. Never surcharged; see tips.ts.
            amount: charge.amountCents,
            // application_fee_amount travels WITH the amount. It was set once at
            // create time from the then-current due amount and never updated,
            // so applying client credit shrank the charge and left the fee
            // where it was: $150 of credit on a $200 invoice charged $50 with
            // a $1.00 fee — 2%, not 0.5% — out of the tenant's settlement. At
            // $1.00 due the fee equalled the whole charge.
            // On the invoice, never on the tip.
            application_fee_amount: platformFeeCents(charge.platformFeeBaseCents),
            currency,
            metadata,
            setup_future_usage: "off_session" as const,
          };
          try {
            pi = await stripe.paymentIntents.update(
              existing.id,
              {
                ...updateParams,
                payment_method_types: paymentMethodTypes,
              },
              opts,
            );
          } catch (e) {
            if (!isBankDebitUnavailableError(e)) throw e;
            pi = await stripe.paymentIntents.update(
              existing.id,
              {
                ...updateParams,
                payment_method_types: ["card"],
              },
              opts,
            );
          }
        }
      } catch (e) {
        // The processing guard is a real answer for the caller, not a
        // retrieve hiccup — let it surface instead of minting a new intent.
        if ((e as Error).message?.startsWith("A payment for this invoice is already processing"))
          throw e;
        console.warn("retrieve existing PI failed, creating new", e);
      }
    }

    if (!pi) {
      const createParams = {
        amount: charge.amountCents,
        application_fee_amount: platformFeeCents(charge.platformFeeBaseCents),
        currency,
        customer: customerId,
        setup_future_usage: "off_session" as const,
        metadata,
      };
      try {
        pi = await stripe.paymentIntents.create(
          {
            ...createParams,
            payment_method_types: paymentMethodTypes,
          },
          opts,
        );
      } catch (e) {
        if (!isBankDebitUnavailableError(e)) throw e;
        pi = await stripe.paymentIntents.create(
          {
            ...createParams,
            payment_method_types: ["card"],
          },
          opts,
        );
      }
      await supabaseAdmin
        .from("invoices")
        .update({
          stripe_payment_intent_id: pi.id,
          status: "open",
        })
        .eq("id", invoice.id);
    }

    const { data: client } = await supabaseAdmin
      .from("clients")
      .select("display_name")
      .eq("id", session.clientId)
      .single();

    return {
      clientSecret: pi.client_secret as string,
      publishableKey,
      stripeAccount: acct.accountId,
      /** What the card will be charged: the invoice plus any tip. */
      amountCents: charge.amountCents,
      /** The invoice alone, which the tip percentages are taken of. */
      dueCents: charge.dueCents,
      tipCents: charge.tipCents,
      tipsEnabled,
      currency,
      invoiceId: invoice.id,
      /** "INV-10427": the number the PDF, the email and the pay link print. */
      invoiceLabel: invoiceNumberLabel({ id: invoice.id, number: invoice.number ?? null }),
      businessName: client?.display_name as string,
    };
  });

// ── The client opting themselves in ───────────────────────────────────────
//
// The strongest evidence a carrier can be shown: the end user, authenticated
// on their own portal session, ticking a box whose exact words are stored with
// the timestamp. Source is 'portal' so an audit can tell this apart from a
// staff member recording consent on someone's behalf.

export const portalSetSmsConsent = createServerFn({ method: "POST" })
  .inputValidator((d) => z.object({ token: z.string().uuid(), optIn: z.boolean() }).parse(d))
  .handler(async ({ data }) => {
    const { requirePortalSession } = await portalAuth();
    const session = await requirePortalSession(data.token);
    const sb = await admin();

    const clientId = (session as any).clientId ?? (session as any).client_id;
    if (!clientId) throw new Error("No client on this portal session");

    if (!data.optIn) {
      // Opting out is not "clear the consent record" — the record of what they
      // once agreed to is the audit trail, and deleting it on withdrawal would
      // destroy the evidence for every message already sent. sms_opt_out is
      // the live switch; the consent columns stay as history.
      const { error } = await (sb.from("clients") as any)
        .update({ sms_opt_out: true })
        .eq("id", clientId);
      if (error) throw new Error(error.message);
      return { ok: true, optedIn: false };
    }

    const { SMS_CONSENT_TEXT } = await import("@/lib/clients.functions");
    const { error } = await sb.rpc("record_client_sms_consent" as any, {
      _client_id: clientId,
      _text: SMS_CONSENT_TEXT,
      _source: "portal",
    });
    if (error) throw new Error(error.message);
    return { ok: true, optedIn: true, text: SMS_CONSENT_TEXT };
  });
