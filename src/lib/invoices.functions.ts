import { createServerFn } from "@tanstack/react-start";
import { refuseIfChanged } from "@/lib/stale-write";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { appOrigin } from "@/lib/app-origin";
import { platformFeeCents } from "@/lib/platform-fee";
import { methodTypesForRail, withPassThroughFees } from "@/lib/radar-fee";
import { taxShareCents } from "@/lib/sales-tax";
import { TIP_CUSTOM_MAX_CENTS, tipChoiceSchema, tipMetadata, tippedCharge } from "@/lib/tips";
import { officeTipProblem } from "@/lib/office-tip";
import { invoiceNumberLabel, invoiceRef } from "@/lib/invoice-labels";
import {
  MANUAL_PAYMENT_METHODS,
  REFERENCE_MAX,
  describeManualPayment,
  receivedAtInstant,
  receivedOnProblem,
} from "@/lib/manual-payments";
import { DEFAULT_ORG_TIMEZONE } from "@/lib/org-day";
import { invoiceDueCents } from "@/lib/ar";
import { formatCents } from "@/lib/digest-alerts";
import {
  QUANTITY_MAX,
  discountLineProblem,
  lineTotalCents,
  manualLinesProblem,
} from "@/lib/invoice-lines";

/** Each payment row with how much of it has been refunded, from the reversal
 *  ledger — so the invoice can say "$30.00 refunded" and hide the Refund button
 *  on a payment that has nothing left. See refundedCentsByPayment. */
async function withRefunded<P extends { id: string }>(
  supabase: unknown,
  orgId: string,
  payments: P[] | null | undefined,
): Promise<(P & { refunded_cents: number })[]> {
  const rows = payments ?? [];
  const { refundedCentsByPayment } = await import("@/lib/refunds.server");
  const refunded = await refundedCentsByPayment(
    supabase,
    orgId,
    rows.map((p) => p.id),
  );
  return rows.map((p) => ({ ...p, refunded_cents: refunded.get(p.id) ?? 0 }));
}

/** Each payment row with the name of the tech its tip was credited to, when
 *  it carries one. Read through the caller's own client, so a name is only
 *  shown to somebody who can already read the staff list. */
async function withTipStaffNames<P extends { tip_staff_id?: string | null }>(
  supabase: any,
  payments: P[],
): Promise<(P & { tip_staff_name: string | null })[]> {
  const ids = [...new Set(payments.map((p) => p.tip_staff_id).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    const { data } = await supabase.from("staff").select("id, display_name").in("id", ids);
    for (const s of (data ?? []) as { id: string; display_name: string }[]) {
      names.set(s.id, s.display_name);
    }
  }
  return payments.map((p) => ({
    ...p,
    tip_staff_name: p.tip_staff_id ? (names.get(p.tip_staff_id) ?? null) : null,
  }));
}

export const listInvoices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data, error } = await supabase
      .from("invoices")
      .select(
        "id, number, client_id, status, kind, subtotal_cents, total_cents, credit_applied_cents, amount_paid_cents, amount_refunded_cents, deposit_for_invoice_id, currency, period_start, period_end, issued_at, paid_at, due_on, send_after, sent_at, public_token, checkout_url, updated_at, clients(display_name)",
      )
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

/**
 * Money collected month-to-date — the Invoices index "Collected this month"
 * card.
 *
 * IMP-10: the page used to compute this in the browser by scanning the invoice
 * list for `status = 'paid'`, dating each one by `paid_at ?? period_end`, and
 * comparing against a month prefix taken from `toISOString()` — i.e. UTC,
 * whatever the org's timezone. The Dashboard did the same job differently
 * (`issued_at`, server clock) and Reports differently again. Three cards, three
 * answers, none of them the amount that reached the bank.
 *
 * A dedicated round trip rather than more arithmetic over the fetched list: the
 * list is invoices, and this question is about PAYMENTS. Deriving one from the
 * other is what produced three implementations in the first place, and the
 * invoice list is paginated in the UI anyway, so a client-side sum was only
 * ever right when nothing had scrolled off.
 */
export const getCollectedThisMonth = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase } = context;
    // view_financials, not manage_client_billing: this is an aggregate money
    // figure, matching the boundary /reports and the Dashboard KPIs already use.
    const { orgId } = await requirePermission(supabase, context.userId, "view_financials");
    const { collectedMonthToDate } = await import("@/lib/revenue.server");
    return collectedMonthToDate(supabase, orgId);
  });

export const getInvoice = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const res = await supabase
      .from("invoices")
      .select("*, clients(display_name, primary_email)")
      .eq("id", data.id)
      .single();
    if (res.error) throw new Error(res.error.message);
    let invoice = res.data;
    // Webhook-independent safety net: an open invoice with a checkout session
    // may have been paid without the webhook landing — verify against Stripe
    // and flip it before rendering.
    if (
      invoice.status === "open" &&
      (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id)
    ) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        const fresh = await supabase
          .from("invoices")
          .select("*, clients(display_name, primary_email)")
          .eq("id", data.id)
          .single();
        if (!fresh.error) invoice = fresh.data;
      }
    }
    const { data: items, error: iErr } = await supabase
      .from("invoice_line_items")
      .select(
        "id, description, amount_cents, quantity, unit_amount_cents, visit_id, subscription_id",
      )
      .eq("invoice_id", data.id)
      .order("created_at");
    if (iErr) throw new Error(iErr.message);
    const { data: payments } = await supabase
      .from("payments")
      // surcharge_cents: `amount_cents` is the invoice amount, NOT what the
      // card was charged. When a surcharge applies the difference is what the
      // customer sees on their statement, and no screen could reconstruct it
      // while this column went unselected.
      // tip_cents: beside the amount like the surcharge, and the tech it was
      // credited to (tip_staff_for_invoice, at the moment it was paid).
      .select(
        "id, amount_cents, surcharge_cents, tip_cents, tip_staff_id, status, stripe_payment_intent_id, paid_at, created_at, method, reference",
      )
      .eq("invoice_id", data.id)
      .order("created_at", { ascending: false });
    const named = await withTipStaffNames(supabase, payments ?? []);
    return {
      invoice,
      items: items ?? [],
      payments: await withRefunded(supabase, orgId, named),
      /** Sent back with a void or a payment, so a stale page is refused (#655). */
      version: invoice.updated_at,
    };
  });

export const generateInvoicesForOrg = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ orgId: z.string().uuid(), through: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    if (orgId !== data.orgId) throw new Error("Not authorized");
    const { data: count, error } = await supabase.rpc("generate_invoices_for_org", {
      _org_id: data.orgId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    return { generated: count as number };
  });

export const generateInvoiceForClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid(), through: z.string() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: id, error } = await supabase.rpc("generate_invoice_for_client", {
      _client_id: data.clientId,
      _through: data.through,
    });
    if (error) throw new Error(error.message);
    if (id) {
      const { logActivity } = await import("@/lib/activity.server");
      const { data: c } = await supabase
        .from("clients")
        .select("organization_id")
        .eq("id", data.clientId)
        .single();
      if (c)
        await logActivity(supabase, {
          orgId: c.organization_id,
          clientId: data.clientId,
          actorUserId: context.userId,
          kind: "invoice.generated",
          summary: `Generated invoice ${await invoiceRef(supabase, String(id))} through ${data.through}`,
        });
    }
    return { invoiceId: id as string };
  });

// P3.1 "quick charge": the only invoice path used to be schedule route →
// complete visit → generate — a solo operator who just did the job had no way
// to say "bill this now." Creates an ordinary open invoice payable through
// every existing path (portal, checkout, saved card).
const manualInvoiceSchema = z.object({
  clientId: z.string().uuid(),
  items: z
    .array(
      z
        .object({
          description: z.string().min(1).max(300),
          // Below zero is a discount line (#653): "Loyalty discount -$5.00".
          // It used to be dropped by the form before it got here.
          amountCents: z.number().int().min(-10_000_000).max(10_000_000),
          // The visit or the pending add-on this line bills (#605). Linking is
          // what keeps the billing run from billing the same work again.
          visitId: z.string().uuid().optional(),
          addonChargeId: z.string().uuid().optional(),
          // Both or neither: a line is either only a total, or "3 × $15.00"
          // whose total is the product. The database refuses a mismatch
          // (invoice_line_items_total_is_quantity_times_unit); refusing it here
          // says which line, before anything is written.
          quantity: z.number().positive().max(QUANTITY_MAX).optional(),
          unitAmountCents: z.number().int().min(0).max(10_000_000).optional(),
        })
        // A $0 line only when it names a visit: a skip the business does not
        // charge for is still work the invoice covers.
        .refine((i) => i.amountCents !== 0 || i.visitId !== undefined, {
          message: "A line needs an amount",
        })
        .superRefine((i, ctx) => {
          const problem = discountLineProblem(i);
          if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        })
        .refine((i) => !(i.visitId && i.addonChargeId), {
          message: "A line bills a visit or an add-on, not both",
        })
        .refine((i) => (i.quantity === undefined) === (i.unitAmountCents === undefined), {
          message: "A line with a quantity needs a unit price, and the other way round",
        })
        .refine(
          (i) =>
            i.quantity === undefined ||
            (Math.abs(i.quantity * 100 - Math.round(i.quantity * 100)) < 1e-6 &&
              lineTotalCents(i.quantity, i.unitAmountCents!) === i.amountCents),
          { message: "A line's total must be its quantity times its unit price" },
        ),
    )
    .min(1)
    .max(25)
    // Discounts may not take the invoice to $0 or below (#653).
    .superRefine((items, ctx) => {
      const problem = manualLinesProblem(items);
      if (problem) ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
    }),
  notes: z.string().max(500).optional(),
  // Minted once each time the dialog opens and sent with every attempt, so a
  // double click or a retry after a lost response makes one invoice (#607).
  creationKey: z.string().uuid().optional(),
});

export const createManualInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => manualInvoiceSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");

    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (client.organization_id !== orgId) throw new Error("Client not found");

    // This dialog already made its invoice: answer with that one, and log
    // nothing. Two requests that both get past here are settled by the
    // unique constraint inside create_manual_invoice, which returns the
    // first one's id to the second.
    if (data.creationKey) {
      const { data: made, error: mErr } = await supabase
        .from("invoices")
        .select("id, client_id, total_cents, tax_cents")
        .eq("organization_id", orgId)
        .eq("creation_key", data.creationKey)
        .maybeSingle();
      if (mErr) throw new Error(mErr.message);
      if (made) {
        if (made.client_id !== data.clientId) throw new Error("This invoice was already created");
        return { invoiceId: made.id, totalCents: made.total_cents, taxCents: made.tax_cents };
      }
    }

    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    return insertManualInvoice(supabase, {
      orgId,
      userId: context.userId,
      clientId: data.clientId,
      items: data.items,
      notes: data.notes,
      creationKey: data.creationKey,
    });
  });

/** The client's work no live invoice covers yet: billable visits and pending
 *  add-ons. The New invoice dialog lists it so the office can say which work
 *  an invoice is for (#605). */
export const listUninvoicedWork = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { uninvoicedWork } = await import("@/lib/visit-invoicing.server");
    return uninvoicedWork(supabase, orgId, data.clientId);
  });

/** What "Invoice this visit" would do for one visit, or the invoice it is
 *  already on, or why it cannot be invoiced. */
export const getVisitInvoicing = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { visitInvoicing } = await import("@/lib/visit-invoicing.server");
    return visitInvoicing(supabase, orgId, data.visitId);
  });

/** Invoice this visit (#605, decision D2: invoice at completion). One open
 *  invoice for the visit and its pending add-ons, each line linked, so the
 *  billing run and Generate from visits leave it alone. */
export const invoiceVisit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { visitInvoicing } = await import("@/lib/visit-invoicing.server");
    const state = await visitInvoicing(supabase, orgId, data.visitId);
    if (state.state === "invoiced") {
      throw new Error(`This visit is already on invoice ${state.invoiceLabel}.`);
    }
    if (state.state === "blocked") throw new Error(state.reason);
    const { data: v, error } = await supabase
      .from("visits")
      .select("client_id, scheduled_on")
      .eq("id", data.visitId)
      .eq("organization_id", orgId)
      .single();
    if (error) throw new Error(error.message);
    // The same key the invoice made at completion carries (#859), so this
    // button and a completion still invoicing make one invoice between them.
    const { nextVisitInvoiceKey } = await import("@/lib/visit-completion-invoice.server");
    const { insertManualInvoice } = await import("@/lib/manual-invoice.server");
    return insertManualInvoice(supabase, {
      orgId,
      userId: context.userId,
      clientId: v.client_id,
      items: state.lines,
      notes: `Visit on ${v.scheduled_on}`,
      activityLabel: `invoice for the visit on ${v.scheduled_on}`,
      period: { start: v.scheduled_on, end: v.scheduled_on },
      creationKey: await nextVisitInvoiceKey(supabase, data.visitId),
    });
  });

/**
 * Two people with one invoice open (#655). The page sends the invoice's
 * updated_at as it was loaded. If somebody has voided it, recorded a payment,
 * applied credit or otherwise saved it since, this one is refused and the
 * office is asked to reload. A payment that changes what is paid counts,
 * because payments_sync_invoice_paid rewrites amount_paid_cents on the
 * invoice and touch_invoices moves updated_at with it; a pending or failed
 * payment row does not. A caller that sends no version is not checked.
 */
async function refuseIfInvoiceChanged(
  supabase: SupabaseClient<Database>,
  invoiceId: string,
  expected: string | null | undefined,
): Promise<void> {
  if (expected === undefined) return;
  const { data: inv, error } = await supabase
    .from("invoices")
    .select("updated_at")
    .eq("id", invoiceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!inv) throw new Error("Invoice not found");
  refuseIfChanged(inv.updated_at, expected);
}

export const voidInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        id: z.string().uuid(),
        // What getInvoice / getInvoiceDetail returned as `version` (#655).
        expectedVersion: z.string().max(64).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    await refuseIfInvoiceChanged(context.supabase, data.id, data.expectedVersion);
    const { error } = await context.supabase.rpc("void_invoice", { _invoice_id: data.id });
    if (error) throw new Error(error.message);

    // CANCEL THE CUSTOMER'S LIVE PAYMENT INTENT. Voiding released the credit
    // and set status='void', and until this call the PaymentIntent minted for
    // the public pay page was still confirmable on the connected account. A
    // client with that tab open could pay a bill the business had cancelled,
    // and nothing downstream would stop it: the webhook's only status test is
    // `!== "paid"` and markInvoicePaidFromStripe claims on `.neq("status",
    // "paid")`, so a `void` invoice passes both and flips to paid.
    //
    // syncInvoicePaymentIntentAmount already cancels when the invoice is not
    // open -- it is what every credit-application path calls, with the comment
    // "a pay page could still confirm the old amount". The void path was the
    // one that never called it. It never throws, so a Stripe outage cannot
    // block a void.
    const { syncInvoicePaymentIntentAmount } = await import("@/lib/invoice-reconcile.server");
    await syncInvoicePaymentIntentAmount(data.id);

    const { data: inv } = await context.supabase
      .from("invoices")
      .select("organization_id, client_id")
      .eq("id", data.id)
      .single();
    if (inv) {
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(context.supabase, {
        orgId: inv.organization_id,
        clientId: inv.client_id,
        actorUserId: context.userId,
        kind: "invoice.voided",
        summary: `Voided invoice ${await invoiceRef(context.supabase, data.id)}`,
      });
    }
    return { ok: true };
  });

export const bulkVoidInvoices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ ids: z.array(z.string().uuid()).min(1).max(500) }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    let ok = 0,
      failed = 0;
    // Same import once, outside the loop.
    const { syncInvoicePaymentIntentAmount } = await import("@/lib/invoice-reconcile.server");
    for (const id of data.ids) {
      const { error } = await context.supabase.rpc("void_invoice", { _invoice_id: id });
      if (error) failed++;
      else {
        // See voidInvoice: without this a customer can still pay a voided
        // invoice from an open pay page. Never throws.
        await syncInvoicePaymentIntentAmount(id);
        ok++;
      }
    }
    return { ok, failed };
  });

export const bulkMarkInvoicesPaid = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        ids: z.array(z.string().uuid()).min(1).max(500),
        note: z.string().optional(),
        // How the money came in. Optional only so an older client build that
        // still sends {ids} keeps working; the dialog always sends it.
        method: z.enum(MANUAL_PAYMENT_METHODS).optional(),
        reference: z.string().trim().max(REFERENCE_MAX).optional(),
        /** The org-calendar day the payment arrived (YYYY-MM-DD). */
        receivedOn: z.string().optional(),
        /** Cash or a check a tech collected in the field (field_collections).
         *  When present, the collection is CLAIMED first -- once, atomically,
         *  against exactly these invoices -- and its own method, check number
         *  and time are what get recorded, whatever else was sent. */
        fieldCollectionId: z.string().uuid().optional(),
        /** Less than the balance is a partial payment; more is refused. One
         *  invoice only. Absent means the whole balance, as it always did. */
        amountCents: z.number().int().min(1).max(100_000_000).optional(),
        /** A tip handed to the office with cash or a check (#653, F-09). One
         *  invoice only. Written beside the payment, never inside it. */
        tipCents: z.number().int().min(1).max(TIP_CUSTOM_MAX_CENTS).optional(),
        /** What getInvoice / getInvoiceDetail returned as `version`. One
         *  invoice only: a page that saw the invoice before somebody else
         *  saved it is refused (#655). */
        expectedVersion: z.string().max(64).nullable().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: org } = await supabase
      .from("organizations")
      .select("timezone")
      .eq("id", orgId)
      .maybeSingle();
    const tz = org?.timezone || DEFAULT_ORG_TIMEZONE;
    const now = new Date();
    if (data.receivedOn) {
      const problem = receivedOnProblem(data.receivedOn, tz, now);
      if (problem) throw new Error(problem);
    }
    // Every manual payment goes through record_invoice_payment, which locks
    // the invoice, refuses more than its balance, writes the payment row and
    // marks the invoice paid only when the balance reaches zero. That one
    // function replaces a read, a status claim and an insert done here, so a
    // double click or a retry cannot write two rows: the second one finds the
    // invoice paid (or the balance smaller) and is refused.
    //
    // A FIELD COLLECTION is confirmed by confirm_field_collection, which
    // applies the cash oldest invoice first, the last one partly, and records
    // those payments in the same transaction. What is left for this loop is
    // the activity line and the pay-page intent for each invoice it touched.
    type Recorded = {
      /** Null when nothing was written (a $0 balance). */
      payment_id?: string | null;
      invoice_id: string;
      organization_id: string;
      client_id: string;
      amount_cents: number;
      balance_cents: number;
      paid: boolean;
    };
    type ClaimedCollection = {
      id: string;
      method: string;
      reference: string | null;
      collected_at: string;
      allocations: Recorded[];
    };
    if (data.amountCents != null && (data.ids.length !== 1 || data.fieldCollectionId)) {
      throw new Error("An amount can only be recorded against one invoice at a time");
    }
    const tipProblem = officeTipProblem(data);
    if (tipProblem) throw new Error(tipProblem);
    if (data.expectedVersion !== undefined) {
      if (data.ids.length !== 1) throw new Error("A version can only be checked on one invoice");
      await refuseIfInvoiceChanged(supabase, data.ids[0], data.expectedVersion);
    }
    let field: ClaimedCollection | null = null;
    if (data.fieldCollectionId) {
      const { data: claimed, error: cErr } = await supabase.rpc("confirm_field_collection", {
        _collection_id: data.fieldCollectionId,
        _invoice_ids: data.ids,
      });
      if (cErr) throw new Error(cErr.message);
      field = claimed as unknown as ClaimedCollection;
    }
    const method = field ? (field.method as (typeof MANUAL_PAYMENT_METHODS)[number]) : data.method;
    // A check received Friday and entered Monday is Friday's income on the
    // cash-basis report, which buckets by orgLocalDay(paid_at). A field
    // collection was received the moment the tech took it.
    const nowIso = field
      ? field.collected_at
      : data.receivedOn
        ? receivedAtInstant(data.receivedOn, tz, now)
        : now.toISOString();
    const reference = field
      ? field.reference
      : method && method !== "cash"
        ? data.reference || null
        : null;
    let ok = 0,
      failed = 0;
    // Partly paid: recorded, and the invoice is still open for the rest.
    const partial: string[] = [];
    // The first refusal, word for word ("That is more than the $20.00 still
    // owed on this invoice"), so a single-invoice caller can show it.
    let refusal: string | null = null;
    // Invoices marked paid whose live PaymentIntent we could NOT cancel. These
    // are not failures -- the invoice IS paid and the row is correct -- but the
    // customer can still be charged on the pay page, and that second charge
    // lands nowhere. Counted separately so the office is told, rather than
    // reading a clean "Marked 12 paid" over a live intent. See the block below.
    const intentStillLive: string[] = [];
    const recorded: Recorded[] = [];
    if (field) {
      recorded.push(...(field.allocations ?? []));
    } else {
      for (const id of data.ids) {
        const { data: r, error: rErr } = await supabase.rpc("record_invoice_payment", {
          _invoice_id: id,
          // Absent: the whole balance, which is what a bulk "mark paid" means.
          _amount_cents: data.amountCents ?? undefined,
          _method: method ?? undefined,
          _reference: reference ?? undefined,
          _paid_at: nowIso,
          _note: data.note ?? undefined,
        });
        if (rErr || !r) {
          failed++;
          refusal ??= rErr?.message ?? null;
          continue;
        }
        recorded.push(r as unknown as Recorded);
      }
    }
    // The office's cash tip goes on the payment row it came with, beside the
    // amount (tests/a-customer-could-not-leave-a-tip.test.ts: no SQL path
    // writes or reads the tip column, so this is the one TypeScript write).
    // Payments have no UPDATE policy; the caller's billing permission was
    // checked above and the row is the one record_invoice_payment just wrote.
    //
    // A failure here is reported, not thrown: the payment IS recorded, and a
    // thrown error reads as "try again", which would record it twice.
    let tipFailed = false;
    if (data.tipCents && recorded[0]?.payment_id) {
      try {
        const { recordOfficeTip } = await import("@/lib/office-tip.server");
        await recordOfficeTip({
          orgId,
          invoiceId: recorded[0].invoice_id,
          paymentId: recorded[0].payment_id,
          tipCents: data.tipCents,
        });
      } catch (e) {
        console.error("[mark-paid] the payment was recorded but its tip was not", e);
        tipFailed = true;
      }
    }
    for (const r of recorded) {
      const how = describeManualPayment(method, reference);
      const label = await invoiceRef(supabase, r.invoice_id);
      const { logActivity } = await import("@/lib/activity.server");
      await logActivity(supabase, {
        orgId: r.organization_id,
        clientId: r.client_id,
        actorUserId: context.userId,
        kind: "invoice.payment_recorded",
        summary: r.paid
          ? `Recorded ${how ? `${how} ` : ""}payment on invoice ${label}`
          : `Recorded ${how ? `${how} ` : ""}partial payment of ${formatCents(r.amount_cents)} on invoice ${label}, ${formatCents(r.balance_cents)} still owed`,
      });
      if (!r.paid) partial.push(r.invoice_id);

      // CANCEL THE CUSTOMER'S LIVE PAYMENT INTENT, for the same reason
      // voidInvoice does and with worse consequences if we do not.
      //
      // A partial payment shrinks it instead: the intent is updated to the
      // balance that is left, so the client cannot pay the old full amount.
      //
      // Marking an invoice paid out of band -- a cheque, cash at the door --
      // says the money is collected. The PaymentIntent minted for the pay page
      // is still confirmable on the connected account until somebody cancels
      // it, and the client may have that tab open. If they press Pay, the card
      // IS charged.
      //
      // What happens next is the part that makes this worse than the void
      // case. The webhook's guard is `inv.status !== "paid"`
      // (routes/api/public/hooks/stripe.ts) -- and this invoice now IS paid, so
      // the branch is skipped entirely. No `payments` row, no receipt, no
      // activity entry, no refund. The money leaves the customer's account and
      // exists nowhere in this system. A voided invoice at least flips to paid
      // and leaves a trace; this one leaves none.
      //
      // Never throws, so a Stripe outage cannot block marking a cheque paid.
      try {
        const { syncInvoicePaymentIntentAmount } = await import("@/lib/invoice-reconcile.server");
        await syncInvoicePaymentIntentAmount(r.invoice_id);
      } catch (e) {
        console.error("[mark-paid] could not sync the pay-page intent for", r.invoice_id, e);
        intentStillLive.push(r.invoice_id);
      }

      ok++;
    }
    return { ok, failed, partial, refusal, intentStillLive, tipFailed };
  });

// In-app payment (Payment Element): staff take a card or ACH payment right on
// the invoice page. Mirrors the portal's portalCreateInvoicePaymentIntent but
// staff-authenticated, and never saves the client's payment method — only the
// client can consent to that from their portal.
const INVOICE_PM_TYPES = ["card", "us_bank_account"];

// ACH requires activation on the connected account; when it isn't enabled the
// PI create/update fails and we retry card-only.
function isBankDebitUnavailableError(e: unknown): boolean {
  const err = e as { message?: string; param?: string };
  return (
    /us_bank_account/i.test(err?.message ?? "") || /payment_method_types/.test(err?.param ?? "")
  );
}

export const createInvoicePaymentIntent = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    // Read invoice + verify access via RLS
    const { data: invoice, error } = await supabase
      .from("invoices")
      .select(
        "id, organization_id, client_id, total_cents, tax_cents, credit_applied_cents, amount_paid_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id",
      )
      .eq("id", data.id)
      .single();
    if (error) throw new Error(error.message);
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    const { stayInvoicePaymentTypes } = await import("@/lib/stay-payment.server");
    const paymentMethodTypes = await stayInvoicePaymentTypes(
      invoice.id,
      invoice.organization_id,
      INVOICE_PM_TYPES,
    );
    // Charge the OPEN amount: total net of applied credit (B7) and of any
    // partial payment already recorded.
    const dueCents = invoiceDueCents(invoice);
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // If a previous session/intent was already paid but the status is stale
    // (webhook missed), reconcile instead of minting a second charge.
    if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const { data: cRow, error: cErr } = await supabase
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", invoice.client_id)
      .single();
    if (cErr) throw new Error(cErr.message);

    // Tenant->client charge: runs on the org's own connected Stripe account.
    const {
      requireOrgStripeAccount,
      connectStripe,
      connectPublishableKey,
      verifyClientStripeCustomer,
    } = await import("@/lib/stripe-connect.server");
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
      await supabase.from("clients").update({ stripe_customer_id: customerId }).eq("id", cRow.id);
    }

    // Stripe bills Radar's screening of this charge to the platform under
    // application_express, so it rides on the application fee (#825).
    const { radarPassThrough } = await import("@/lib/connect-fee-payer.server");
    const radar = await radarPassThrough(stripe, acct.accountId, paymentMethodTypes);
    const currency = (invoice.currency ?? "usd").toLowerCase();
    const metadata = {
      invoice_id: invoice.id,
      organization_id: invoice.organization_id,
      source: "staff_inline",
      ...radar.metadata,
      // No tip is offered to staff taking a payment, and this intent may be
      // the one a customer tipped on and abandoned. Stripe merges metadata on
      // update, so a stale tip_cents would survive the amount going back to
      // `dueCents` and the webhook would under-credit the invoice by it.
      ...tipMetadata(0),
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
        // replacement intent would lose the reference and invite a second
        // charge while the debit clears.
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
          // intents stop offering Klarna/Affirm/etc., and CLEARS
          // setup_future_usage — a portal-minted intent saves the client's
          // card by consent, but a card typed by staff must never be saved.
          const updateParams = {
            amount: dueCents,
            // application_fee_amount travels WITH the amount. It was set once at
            // create time from the then-current due amount and never updated,
            // so applying client credit shrank the charge and left the fee
            // where it was: $150 of credit on a $200 invoice charged $50 with
            // a $1.00 fee — 2%, not 0.5% — out of the tenant's settlement. At
            // $1.00 due the fee equalled the whole charge.
            application_fee_amount: withPassThroughFees(
              platformFeeCents(dueCents, invoice),
              radar.cents,
            ),
            currency,
            metadata,
            setup_future_usage: "" as const,
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
      // No setup_future_usage here: staff must not save the client's payment
      // method without the client's own consent (portal flow only).
      const createParams = {
        amount: dueCents,
        application_fee_amount: withPassThroughFees(
          platformFeeCents(dueCents, invoice),
          radar.cents,
        ),
        currency,
        customer: customerId,
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
      const { error: upErr } = await supabase
        .from("invoices")
        .update({ stripe_payment_intent_id: pi.id, status: "open" })
        .eq("id", invoice.id);
      if (upErr) throw new Error(upErr.message);
    }

    return {
      clientSecret: pi.client_secret as string,
      publishableKey: connectPublishableKey(),
      stripeAccount: acct.accountId,
      amountCents: dueCents,
      currency,
    };
  });

// Shared saved-card charge implementation (B7): the same off-session charge
// autopay/the portal use, on demand from the invoice drawer. The processing-PI
// guard, reconcile-before-charge, idempotency key and activity log exist here
// exactly once. Charges the invoice's OPEN amount (total_cents -
// credit_applied_cents), never the gross total.
//
// It had two callers. `chargeInvoiceWithSavedCard` was a bare wrapper that no
// screen ever imported, and it charged the open amount WITHOUT first applying
// the client's account credit — wiring it up would have taken money from a
// customer who had already paid part of the bill. Deleted rather than fixed:
// chargeAutopayForInvoice below is the same call done in the right order, and
// it is the one the invoice drawer and the full invoice page both use.
async function chargeSavedCardCore(
  supabase: SupabaseClient<Database>,
  actorUserId: string,
  invoiceId: string,
): Promise<{ chargedCents: number; status: string }> {
  const { data: invoiceRow, error: iErr } = await supabase
    .from("invoices")
    .select(
      "id, organization_id, client_id, total_cents, tax_cents, credit_applied_cents, amount_paid_cents, currency, status, stripe_checkout_session_id, stripe_payment_intent_id",
    )
    .eq("id", invoiceId)
    .single();
  if (iErr) throw new Error(iErr.message);
  const invoice = invoiceRow;
  if (invoice.status === "paid") throw new Error("Invoice already paid");
  if (invoice.status === "void") throw new Error("Invoice is voided");
  // Drafts are unfinalized: send (or finalize) the invoice before collecting.
  // Charging a draft would also skip the credit-first ordering, since
  // apply_credit_to_invoice only touches open invoices.
  if (invoice.status !== "open") throw new Error("Only open invoices can be charged");
  const dueCents = invoiceDueCents(invoice);
  if (dueCents <= 0) throw new Error("Nothing due on this invoice");
  // Stale-open guard: if a prior session/intent already paid this invoice
  // (webhook missed), reconcile instead of charging the saved card too.
  if (invoice.stripe_checkout_session_id || invoice.stripe_payment_intent_id) {
    const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
    if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
      throw new Error("Invoice already paid");
    }
  }

  const { data: c, error: cErr } = await supabase
    .from("clients")
    .select(
      "id, stripe_customer_id, default_payment_method_id, default_card_brand, default_card_last4",
    )
    .eq("id", invoice.client_id)
    .single();
  // In-flight bank debit guard (same rule as the minting fns): a stored PI
  // in "processing" means the invoice IS being paid — charging the saved
  // card on top would collect twice when the debit clears.
  if (invoice.stripe_payment_intent_id) {
    const { requireOrgStripeAccount: acctFn, connectStripe: stripeFn } =
      await import("@/lib/stripe-connect.server");
    const guardAcct = await acctFn(invoice.organization_id);
    const guardStripe = await stripeFn();
    try {
      const existing = await guardStripe.paymentIntents.retrieve(
        invoice.stripe_payment_intent_id,
        {},
        { stripeAccount: guardAcct.accountId },
      );
      if (existing.status === "processing") {
        throw new Error(
          "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
        );
      }
      // A still-confirmable intent may be sitting in a client's open pay page
      // (portal or public link) at the OLD amount. Cancel it before charging
      // here, or the client could confirm it after this charge and pay twice.
      if (
        existing.status === "requires_payment_method" ||
        existing.status === "requires_confirmation" ||
        existing.status === "requires_action"
      ) {
        await guardStripe.paymentIntents.cancel(
          existing.id,
          {},
          { stripeAccount: guardAcct.accountId },
        );
      }
    } catch (e) {
      if ((e as Error).message?.startsWith("A payment for this invoice is already processing"))
        throw e;
      // Retrieve/cancel hiccups don't block the charge; the reconcile above ran.
    }
  }
  if (cErr) throw new Error(cErr.message);
  if (!c.stripe_customer_id || !c.default_payment_method_id) {
    throw new Error("No saved card on file for this client");
  }

  const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } =
    await import("@/lib/stripe-connect.server");
  const acct = await requireOrgStripeAccount(invoice.organization_id);
  const stripe = await connectStripe();
  // Saved-card refs can be orphaned by a connected-account cutover; verify
  // before charging so staff get "re-add the card" instead of a raw
  // "No such customer: 'cus_…'".
  const liveCustomerId = await verifyClientStripeCustomer(stripe, acct.accountId, c);
  if (!liveCustomerId) {
    throw new Error(
      "The saved card is no longer on file. Ask the client to add a payment method again.",
    );
  }
  // Saved card: rail and funding are knowable before the charge, so this path
  // stays one step. Platform fee remains on the BASE.
  const { orgFeeConfig, quoteForPaymentMethodId, surchargeMetadata } =
    await import("@/lib/processing-fee.server");
  const { supabaseAdmin: feeAdmin } = await import("@/integrations/supabase/client.server");
  const quote = await quoteForPaymentMethodId(stripe, {
    paymentMethodId: c.default_payment_method_id,
    stripeAccount: acct.accountId,
    baseCents: dueCents,
    // The sales tax inside what is due is not surcharged (processing-fee.ts).
    taxCents: taxShareCents(dueCents, invoice.tax_cents, invoice.total_cents),
    config: await orgFeeConfig(feeAdmin, invoice.organization_id),
  });
  const { stayInvoicePaymentTypes } = await import("@/lib/stay-payment.server");
  const stayRails = await stayInvoicePaymentTypes(invoice.id, invoice.organization_id, []);
  // The saved method's rail is known, so a bank debit carries no Radar fee
  // and a card does (#825).
  const { radarPassThrough } = await import("@/lib/connect-fee-payer.server");
  const radar = await radarPassThrough(stripe, acct.accountId, methodTypesForRail(quote.rail));
  try {
    const pi = await stripe.paymentIntents.create(
      {
        amount: quote.totalCents,
        application_fee_amount: withPassThroughFees(
          platformFeeCents(dueCents, invoice),
          radar.cents,
        ),
        currency: invoice.currency ?? "usd",
        customer: c.stripe_customer_id,
        payment_method: c.default_payment_method_id,
        ...(stayRails.length ? { payment_method_types: stayRails } : {}),
        off_session: true,
        confirm: true,
        metadata: {
          invoice_id: invoice.id,
          organization_id: invoice.organization_id,
          source: "staff_saved_card",
          ...surchargeMetadata(quote),
          ...radar.metadata,
        },
      },
      {
        // Prevent a double-click (or a retried request) from charging twice.
        // The payment-method id is part of the key: after a decline the
        // client may save a NEW card the same day, and replaying the old
        // key with different params would be an idempotency_error. The amount
        // is the CHARGED total, so applying more credit — or the tenant turning
        // fee pass-through on — mints a fresh key rather than replaying this one
        // with a different amount, which is that same idempotency_error.
        idempotencyKey: `staff-saved-card-${invoice.id}-${quote.totalCents}-${c.default_payment_method_id}`,
        stripeAccount: acct.accountId,
      },
    );
    if (pi.status === "succeeded") {
      // Card settled synchronously: flip to paid NOW instead of leaving the
      // row open until the webhook lands — the UI refetches immediately after
      // this call and must see the payment (QA: "didn't reflect paid until I
      // refreshed the session"). markInvoicePaidFromStripe is an atomic claim,
      // so the webhook's later attempt becomes a harmless no-op. The flip is
      // best-effort: the CHARGE succeeded, so a transient DB error here must
      // not surface as "Card charge failed" — the webhook rescues the state.
      try {
        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { markInvoicePaidFromStripe } = await import("@/lib/invoice-reconcile.server");
        await markInvoicePaidFromStripe(supabaseAdmin, {
          invoiceId: invoice.id,
          organizationId: invoice.organization_id,
          amountCents: dueCents,
          // The charge was `quote.totalCents` — base + surcharge — and this
          // path dropped the surcharge on the floor, so `payments.surcharge_cents`
          // read 0 for every saved-card charge that settled synchronously,
          // which is most of them. The webhook path has always recorded it
          // (`surchargeFromMetadata(pi.metadata)`); this one silently did not,
          // so the SAME charge produced different rows depending on whether
          // Stripe answered in-band or via the hook.
          //
          // Two things went wrong downstream. Fee recovery was under-reported
          // to the tenant, and — worse — the refund ledger derives the
          // revenue-affecting portion of a refund from base = charged −
          // surcharge, so a surcharge recorded as 0 makes a refund deduct the
          // surcharge from revenue that never contained it.
          surchargeCents: quote.surchargeCents,
          currency: invoice.currency ?? "usd",
          paymentIntentId: pi.id,
          raw: { source: "staff_saved_card_sync", payment_intent: pi.id },
        });
      } catch (flipErr) {
        console.warn(
          "post-charge paid flip failed (webhook will rescue):",
          (flipErr as Error).message,
        );
      }
    } else {
      // Async settlement (e.g. ACH "processing"): stays open until the
      // webhook / reconcile confirms.
      await supabase
        .from("invoices")
        .update({ stripe_payment_intent_id: pi.id, status: "open" })
        .eq("id", invoice.id);
    }
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId: invoice.organization_id,
      clientId: invoice.client_id,
      actorUserId,
      kind: "invoice.charged_saved_card",
      summary: `Charged saved card (${c.default_card_brand ?? "card"} ····${c.default_card_last4 ?? "????"}) for invoice ${await invoiceRef(supabase, invoice.id)}: $${(dueCents / 100).toFixed(2)}`,
    });
    return { chargedCents: dueCents, status: pi.status };
  } catch (e) {
    throw new Error((e as Error).message || "Card charge failed");
  }
}

// Immediately reconcile an invoice against Stripe after a client-side
// PaymentElement confirmation. The webhook is the real-time path, but the UI
// refetches right away — without this, a just-paid invoice reads back "open"
// until the webhook lands (the "didn't reflect until refresh" bug).
export const reconcileInvoiceNow = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: inv, error } = await supabase
      .from("invoices")
      .select("id, organization_id, status")
      .eq("id", data.invoiceId)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!inv) throw new Error("Invoice not found");
    if (inv.status !== "open") return { ok: true, status: inv.status };
    const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
    const status = await reconcileInvoicePayment(data.invoiceId);
    return { ok: true, status };
  });

// ── Credit application (B7) ─────────────────────────────────────────────────
// The DB routine public.apply_credit_to_invoice is the single writer: it
// debits the credit ledger ('invoice_application' via post_credit_entry),
// bumps invoices.credit_applied_cents, and flips the invoice to paid only
// when fully covered. It deliberately writes NO payments row — payments is
// the cash ledger (royalties, digests, and platform metrics sum it as
// collected revenue) and a credit application moves no new cash. It is
// idempotent and concurrency-safe (advisory lock + row locks), so a
// double-click can never apply twice.
async function applyCreditViaRpc(
  supabase: any,
  invoiceId: string,
): Promise<{
  appliedCents: number;
  remainingDueCents: number;
  invoiceStatus: string;
  reason: string;
}> {
  const { data, error } = await supabase.rpc("apply_credit_to_invoice", {
    _invoice_id: invoiceId,
  });
  if (error) throw new Error(error.message);
  const r = (data ?? {}) as Record<string, unknown>;
  return {
    appliedCents: Number(r.applied_cents ?? 0),
    remainingDueCents: Number(r.remaining_due_cents ?? 0),
    invoiceStatus: String(r.invoice_status ?? "open"),
    reason: String(r.reason ?? ""),
  };
}

async function logCreditApplied(
  supabase: any,
  actorUserId: string,
  invoiceId: string,
  appliedCents: number,
) {
  const { data: inv } = await supabase
    .from("invoices")
    .select("organization_id, client_id")
    .eq("id", invoiceId)
    .single();
  if (!inv) return;
  const { logActivity } = await import("@/lib/activity.server");
  await logActivity(supabase, {
    orgId: inv.organization_id,
    clientId: inv.client_id,
    actorUserId,
    kind: "invoice.credit_applied",
    summary: `Applied $${(appliedCents / 100).toFixed(2)} credit to invoice ${await invoiceRef(supabase, invoiceId)}`,
    meta: { amount_cents: appliedCents, invoice_id: invoiceId },
  });
}

/** Apply the client's available credit balance to an open invoice:
 * min(credit balance, open amount) moves through the credit ledger; the
 * invoice is marked paid when fully covered, else its amount due shrinks. */
export const applyCreditToInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { invoiceHasProcessingIntent, syncInvoicePaymentIntentAmount } =
      await import("@/lib/invoice-reconcile.server");
    // An in-flight bank debit is already paying this invoice — applying credit
    // now would collect twice when the debit clears.
    if (await invoiceHasProcessingIntent(data.invoiceId)) {
      throw new Error(
        "A bank payment for this invoice is already processing. Wait for it to clear before applying credit.",
      );
    }
    const res = await applyCreditViaRpc(supabase, data.invoiceId);
    if (res.reason === "prepaid_topup") {
      throw new Error(
        "Credit can't be applied to a prepaid top-up invoice (paying it grants credit).",
      );
    }
    if (res.appliedCents > 0) {
      await logCreditApplied(supabase, context.userId, data.invoiceId, res.appliedCents);
      // A pay page may already hold an intent minted at the pre-credit amount;
      // shrink it (or cancel it when nothing is left due) so the client can't
      // confirm the stale gross charge.
      await syncInvoicePaymentIntentAmount(data.invoiceId);
    }
    return {
      appliedCents: res.appliedCents,
      remainingDueCents: res.remainingDueCents,
      invoiceStatus: res.invoiceStatus,
    };
  });

/** "Charge autopay" for one invoice (B2/B7, I8 "credits auto-applied first"):
 * applies available credit first, then charges only the remaining due to the
 * client's default saved card via chargeSavedCardCore (processing-PI guard,
 * reconcile, idempotency, activity log included). The ONE way staff take a
 * saved-card payment — see the note on chargeSavedCardCore for what the other
 * one did wrong. */
export const chargeAutopayForInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    // Check for an in-flight bank debit BEFORE applying credit — the core
    // charge fn guards its own step, but by then the credit would already be
    // consumed on an invoice that is being paid.
    const { invoiceHasProcessingIntent } = await import("@/lib/invoice-reconcile.server");
    if (await invoiceHasProcessingIntent(data.invoiceId)) {
      throw new Error(
        "A payment for this invoice is already processing. Bank payments can take a few days to clear.",
      );
    }
    const credit = await applyCreditViaRpc(supabase, data.invoiceId);
    if (credit.invoiceStatus === "void") throw new Error("Invoice is voided");
    if (credit.appliedCents > 0) {
      await logCreditApplied(supabase, context.userId, data.invoiceId, credit.appliedCents);
    }
    // Fully covered by credit — nothing to charge. Cancel any stale
    // confirmable intent (a pay page could still confirm the old amount).
    if (credit.invoiceStatus === "paid" || credit.remainingDueCents <= 0) {
      const { syncInvoicePaymentIntentAmount } = await import("@/lib/invoice-reconcile.server");
      await syncInvoicePaymentIntentAmount(data.invoiceId);
      return {
        appliedCreditCents: credit.appliedCents,
        chargedCents: 0,
        status: credit.invoiceStatus === "paid" ? "paid" : credit.invoiceStatus,
      };
    }
    const charge = await chargeSavedCardCore(supabase, context.userId, data.invoiceId);
    return {
      appliedCreditCents: credit.appliedCents,
      chargedCents: charge.chargedCents,
      status: charge.status,
    };
  });

export const generatePrepaidInvoice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ subscriptionId: z.string().uuid(), visitCount: z.number().int().min(1).max(52) })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { data: id, error } = await context.supabase.rpc("generate_prepaid_invoice", {
      _subscription_id: data.subscriptionId,
      _visit_count: data.visitCount,
    });
    if (error) throw new Error(error.message);
    return { invoiceId: id as string };
  });

export const getClientCredit = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: client, error } = await supabase
      .from("clients")
      .select("credit_balance_cents")
      .eq("id", data.clientId)
      .single();
    if (error) throw new Error(error.message);
    const { data: ledger, error: lErr } = await supabase
      .from("credit_ledger")
      .select("id, delta_cents, kind, note, invoice_id, visit_id, created_at")
      .eq("client_id", data.clientId)
      .order("created_at", { ascending: false })
      .limit(50);
    if (lErr) throw new Error(lErr.message);
    return { balanceCents: client.credit_balance_cents ?? 0, ledger: ledger ?? [] };
  });

export const getClientBillingSummary = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    await requirePermission(supabase, context.userId, "manage_client_billing");

    const [clientRes, invoicesRes] = await Promise.all([
      supabase
        .from("clients")
        .select(
          "autopay_enabled, default_card_brand, default_card_last4, default_payment_method_id, stripe_customer_id, primary_email, autopay_paused, autopay_failure_count, autopay_last_error, autopay_last_attempt_at",
        )
        .eq("id", data.clientId)
        .single(),
      supabase
        .from("invoices")
        .select(
          "id, number, status, kind, currency, subtotal_cents, total_cents, credit_applied_cents, amount_paid_cents, amount_refunded_cents, deposit_for_invoice_id, period_start, period_end, issued_at, paid_at, due_on, send_after, sent_at, public_token, checkout_url, created_at",
        )
        .eq("client_id", data.clientId)
        .order("created_at", { ascending: false })
        .limit(25),
    ]);
    if (clientRes.error) throw new Error(clientRes.error.message);

    const invoices = invoicesRes.data ?? [];
    const invoiceIds = invoices.map((i) => i.id);
    const paymentsRes = invoiceIds.length
      ? await supabase
          .from("payments")
          .select(
            "id, invoice_id, amount_cents, surcharge_cents, tip_cents, status, stripe_payment_intent_id, paid_at, created_at",
          )
          .in("invoice_id", invoiceIds)
          .order("created_at", { ascending: false })
          .limit(50)
      : { data: [] as any[] };

    const openInvoices = invoices.filter((i) => i.status === "open");
    // Shared AR math (B1/B7): open balance net of applied credit.
    const { sumOutstandingCents } = await import("@/lib/ar");

    return {
      client: clientRes.data,
      invoices,
      payments: paymentsRes.data ?? [],
      openCount: openInvoices.length,
      openTotalCents: sumOutstandingCents(openInvoices),
    };
  });

// Manual override: staff can reset a client's dunning ladder (clears the
// failure count + paused flag) so the next nightly run tries again. Useful
// after the client updates their card outside the portal.
export const resumeAutopay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_client_billing");
    const { error } = await context.supabase
      .from("clients")
      .update({
        autopay_paused: false,
        autopay_failure_count: 0,
        autopay_last_error: null,
      })
      .eq("id", data.clientId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Shared invoice drawer (QA round 8, was follow-up 2.3): line items, payment
 * attempts, due date, and the client context the drawer's action buttons need
 * (saved card, email address) — without leaving the current page. */
export const getInvoiceDetail = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ invoiceId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const [
      { data: invoice, error: iErr },
      { data: lines, error: lErr },
      { data: pays, error: pErr },
      { data: org },
    ] = await Promise.all([
      supabase
        .from("invoices")
        .select(
          "id, number, client_id, status, kind, currency, subtotal_cents, tax_cents, tax_rate_bps, tax_label, total_cents, credit_applied_cents, amount_paid_cents, amount_refunded_cents, period_start, period_end, issued_at, paid_at, due_on, send_after, sent_at, public_token, voided_at, notes, checkout_url, created_at, updated_at, clients(id, display_name, primary_email, default_payment_method_id, default_card_brand, default_card_last4)",
        )
        .eq("id", data.invoiceId)
        .single(),
      supabase
        .from("invoice_line_items")
        .select(
          "id, description, amount_cents, quantity, unit_amount_cents, visit_id, subscription_id, created_at",
        )
        .eq("invoice_id", data.invoiceId)
        .order("created_at"),
      supabase
        .from("payments")
        .select(
          "id, amount_cents, surcharge_cents, tip_cents, status, paid_at, created_at, stripe_payment_intent_id, method, reference",
        )
        .eq("invoice_id", data.invoiceId)
        .order("created_at", { ascending: false }),
      supabase
        .from("organizations")
        .select("stripe_connect_charges_enabled")
        .eq("id", orgId)
        .maybeSingle(),
    ]);
    if (iErr) throw new Error(iErr.message);
    if (lErr) throw new Error(lErr.message);
    if (pErr) throw new Error(pErr.message);
    // `.single()` errors on a missing row, so iErr above already covers it;
    // this guard is only here to satisfy the nullable `data` type.
    if (!invoice) throw new Error("Invoice not found");
    // Split the embedded client off the invoice row: the drawer's action
    // buttons want it as its own object.
    // `credit_applied_cents` is the portion of total already covered by
    // applied credit (B7); the amount due is total_cents - credit_applied_cents.
    const { clients, ...inv } = invoice;
    return {
      invoice: inv,
      client: clients ?? null,
      lineItems: lines ?? [],
      payments: await withRefunded(supabase, orgId, pays),
      /** Whether a card can be taken at all. Without a connected Stripe
       *  account every card path fails, and the office should be pointed at
       *  Record payment instead of shown a red error. */
      cardPaymentsReady: !!org?.stripe_connect_charges_enabled,
      /** Sent back with a void or a payment, so a stale drawer is refused (#655). */
      version: inv.updated_at,
    };
  });

// ── Credits (QA round 8) ────────────────────────────────────────────────────

/** Staff-issued credit adjustment: goodwill, service recovery, referral bonus.
 * Posts through the same ledger RPC prepay/visit debits use so the balance
 * and ledger never drift, and leaves an activity-log entry with the reason. */
export const addClientCredit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        // Positive adds credit; negative corrects an over-grant.
        amountCents: z
          .number()
          .int()
          .min(-1_000_000)
          .max(1_000_000)
          .refine((n) => n !== 0, "Amount can't be zero"),
        reason: z.string().min(2).max(300),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { orgId } = await requirePermission(supabase, context.userId, "manage_client_billing");
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("id, organization_id, credit_balance_cents")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);
    if (client.organization_id !== orgId) throw new Error("Client not found");

    const { error } = await supabase.rpc("post_credit_entry", {
      _org_id: orgId,
      _client_id: data.clientId,
      _delta: data.amountCents,
      _kind: "adjustment",
      _invoice_id: null as any,
      _visit_id: null as any,
      _note: data.reason,
    });
    if (error) throw new Error(error.message);

    const dollars = `$${(Math.abs(data.amountCents) / 100).toFixed(2)}`;
    const { logActivity } = await import("@/lib/activity.server");
    await logActivity(supabase, {
      orgId,
      clientId: data.clientId,
      actorUserId: context.userId,
      kind: "client.credit_adjusted",
      summary: `${data.amountCents > 0 ? "Added" : "Removed"} ${dollars} credit: ${data.reason}`,
      meta: { amount_cents: data.amountCents, reason: data.reason },
    });
    return {
      ok: true,
      balanceCents: (client.credit_balance_cents ?? 0) + data.amountCents,
    };
  });

// ── Public pay link (QA round 8): /pay/i/{token} ────────────────────────────
//
// NO auth middleware on these two — the unguessable invoices.public_token IS
// the capability, same model as the portal/signup public fns. They run via
// the service-role client after loading the invoice by token, and return
// display data only (org name + client display name, no other client PII).

async function publicAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

async function invoiceByPublicToken(token: string) {
  const sb = await publicAdmin();
  const { data, error } = await sb
    .from("invoices")
    .select(
      // `organizations(timezone)` so the public pay page can date "overdue" in
      // the business's day rather than the server's — it used to keep its own
      // copy of the date logic, with the bug src/lib/overdue.ts documents.
      "id, number, organization_id, client_id, status, kind, currency, subtotal_cents, tax_cents, tax_rate_bps, tax_label, total_cents, credit_applied_cents, amount_paid_cents, period_start, period_end, issued_at, paid_at, due_on, stripe_payment_intent_id, stripe_checkout_session_id, organizations(name, timezone), clients(display_name)",
    )
    .eq("public_token", token)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export const getPublicInvoice = createServerFn({ method: "GET" })
  .inputValidator((d) => z.object({ token: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const invoice = await invoiceByPublicToken(data.token);
    if (!invoice) return { found: false as const };
    const sb = await publicAdmin();
    // Webhook-independent safety net (same as the portal list): the client may
    // reopen the link right after paying, before the webhook lands.
    if (
      invoice.status === "open" &&
      (invoice.stripe_payment_intent_id || invoice.stripe_checkout_session_id)
    ) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        invoice.status = "paid";
        invoice.paid_at = invoice.paid_at ?? new Date().toISOString();
      }
    }
    const { data: items } = await sb
      .from("invoice_line_items")
      .select("id, description, amount_cents, quantity, unit_amount_cents")
      .eq("invoice_id", invoice.id)
      .order("created_at");
    const org = Array.isArray(invoice.organizations)
      ? invoice.organizations[0]
      : invoice.organizations;
    const client = Array.isArray(invoice.clients) ? invoice.clients[0] : invoice.clients;
    return {
      found: true as const,
      invoice: {
        id: invoice.id as string,
        label: invoiceNumberLabel({ id: String(invoice.id), number: invoice.number ?? null }),
        status: invoice.status as string,
        currency: (invoice.currency ?? "usd") as string,
        subtotalCents: invoice.subtotal_cents as number | null,
        // Sales tax, drawn as its own line only when non-zero.
        taxCents: (invoice.tax_cents ?? 0) as number,
        taxRateBps: (invoice.tax_rate_bps ?? 0) as number,
        taxLabel: (invoice.tax_label ?? null) as string | null,
        totalCents: (invoice.total_cents ?? 0) as number,
        // B7: credit already applied and the net amount actually due.
        creditAppliedCents: (invoice.credit_applied_cents ?? 0) as number,
        // Partial payments: what was paid already, and the rest that is due.
        amountPaidCents: (invoice.amount_paid_cents ?? 0) as number,
        amountDueCents: invoiceDueCents(invoice),
        periodStart: invoice.period_start as string | null,
        periodEnd: invoice.period_end as string | null,
        issuedAt: invoice.issued_at as string | null,
        paidAt: invoice.paid_at as string | null,
        dueOn: invoice.due_on as string | null,
      },
      orgName: (org?.name ?? "Your service provider") as string,
      orgTimezone: (org?.timezone ?? null) as string | null,
      clientName: (client?.display_name ?? null) as string | null,
      items: (items ?? []).map((i) => ({
        id: i.id as string,
        description: i.description as string,
        amountCents: i.amount_cents as number,
        quantity: i.quantity as number,
        unitAmountCents: (i.unit_amount_cents ?? null) as number | null,
      })),
    };
  });

export const createPublicInvoicePaymentIntent = createServerFn({ method: "POST" })
  .inputValidator((d) =>
    z
      .object({
        token: z.string().uuid(),
        // The payer's tip CHOICE, never an amount to charge. See src/lib/tips.ts:
        // the server turns it into cents against the invoice it reads itself.
        tip: tipChoiceSchema.optional(),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const publishableKey = process.env.STRIPE_CONNECT_PUBLISHABLE_KEY;
    if (!publishableKey) throw new Error("Payments not configured");

    const invoice = await invoiceByPublicToken(data.token);
    if (!invoice) throw new Error("Invoice not found");
    if (invoice.status === "paid") throw new Error("Invoice already paid");
    if (invoice.status === "void") throw new Error("Invoice is voided");
    const { stayInvoicePaymentTypes } = await import("@/lib/stay-payment.server");
    const paymentMethodTypes = await stayInvoicePaymentTypes(
      invoice.id,
      invoice.organization_id,
      INVOICE_PM_TYPES,
    );
    // Charge the OPEN amount: total net of applied credit (B7) and of any
    // partial payment already recorded.
    const dueCents = invoiceDueCents(invoice);
    if (dueCents <= 0) throw new Error("Nothing due on this invoice");
    // The tip, decided here and only here: a percent from the fixed list or a
    // custom amount under the cap, taken of `dueCents` as read above. Refused
    // outright when the business has tipping off, rather than silently
    // dropped, so a forged request learns nothing it could retry around.
    const { data: tipOrg } = await (
      await publicAdmin()
    )
      .from("organizations")
      .select("tips_enabled")
      .eq("id", invoice.organization_id)
      .maybeSingle();
    const tipsEnabled = !!(tipOrg as { tips_enabled?: boolean | null } | null)?.tips_enabled;
    const charge = tippedCharge({ dueCents, choice: data.tip, tipsEnabled, invoice });
    // If the stored intent OR a legacy hosted-checkout session already
    // succeeded but the status is stale (webhook missed), reconcile instead
    // of minting a new intent and charging a second time.
    if (invoice.stripe_payment_intent_id || invoice.stripe_checkout_session_id) {
      const { reconcileInvoicePayment } = await import("@/lib/invoice-reconcile.server");
      if ((await reconcileInvoicePayment(invoice.id)) === "marked_paid") {
        throw new Error("Invoice already paid");
      }
    }

    const supabaseAdmin = await publicAdmin();
    const { data: cRow } = await supabaseAdmin
      .from("clients")
      .select("id, stripe_customer_id, primary_email, display_name")
      .eq("id", invoice.client_id)
      .single();
    if (!cRow) throw new Error("Invoice not found");

    const { requireOrgStripeAccount, connectStripe, verifyClientStripeCustomer } =
      await import("@/lib/stripe-connect.server");
    // The customer on /pay/i/{token} reads this, not the owner (R2-42).
    const acct = await requireOrgStripeAccount(invoice.organization_id, { audience: "customer" });
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

    // Stripe bills Radar's screening of this charge to the platform under
    // application_express, so it rides on the application fee (#825).
    const { radarPassThrough } = await import("@/lib/connect-fee-payer.server");
    const radar = await radarPassThrough(stripe, acct.accountId, paymentMethodTypes);
    const currency = (invoice.currency ?? "usd").toLowerCase();
    const metadata = {
      invoice_id: invoice.id,
      organization_id: invoice.organization_id,
      source: "public_link",
      ...radar.metadata,
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
        // replacement intent would lose the reference and invite a second
        // charge while the debit clears.
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
          // intents stop offering Klarna/Affirm/etc., and CLEARS
          // setup_future_usage — the anonymous pay-link flow must never save
          // the card (only the client's own portal session can consent).
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
            application_fee_amount: withPassThroughFees(
              platformFeeCents(charge.platformFeeBaseCents),
              radar.cents,
            ),
            currency,
            metadata,
            setup_future_usage: "" as const,
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
      // No setup_future_usage: an anonymous pay-link payer never has their
      // payment method saved.
      const createParams = {
        amount: charge.amountCents,
        application_fee_amount: withPassThroughFees(
          platformFeeCents(charge.platformFeeBaseCents),
          radar.cents,
        ),
        currency,
        customer: customerId,
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
      const { error: upErr } = await supabaseAdmin
        .from("invoices")
        .update({ stripe_payment_intent_id: pi.id, status: "open" })
        .eq("id", invoice.id);
      if (upErr) throw new Error(upErr.message);
    }

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
    };
  });
