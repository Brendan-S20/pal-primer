import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { addDaysToDay } from "@/lib/reclean";
import { invoiceRef } from "@/lib/invoice-labels";
import { newInvoice } from "@/lib/db-insert";
import { effectiveTaxRateBps, invoiceTotals } from "@/lib/sales-tax";

/** One line of a hand-made invoice. `amountCents` is the line total; a line
 *  with a quantity also carries the price of one, and the database holds the
 *  two together (invoice_line_items_total_is_quantity_times_unit). */
export type ManualInvoiceItem = {
  description: string;
  amountCents: number;
  quantity?: number;
  unitAmountCents?: number;
  /** The visit this line bills. Written as invoice_line_items.visit_id, which
   *  is what keeps the billing run from billing the visit again (#605). */
  visitId?: string;
  /** The pending add-on charge this line bills. It is marked invoiced against
   *  the line, so the billing run no longer picks it up. */
  addonChargeId?: string;
};

/** Insert an open invoice and its lines for a client the caller has already
 *  checked belongs to `orgId`. Shared by the New invoice dialog and by
 *  invoicing a quote's one-time charges, so both date the invoice on the
 *  org's day, apply its payment terms, and write it all or nothing the same
 *  way. */
export async function insertManualInvoice(
  supabase: SupabaseClient<any>,
  p: {
    orgId: string;
    /** Null when nobody signed in made it: a client buying in the portal. */
    userId: string | null;
    clientId: string;
    items: ManualInvoiceItem[];
    notes?: string;
    /** What the activity log calls it: "manual invoice", "invoice for Q-1001". */
    activityLabel?: string;
    /** The days the invoice covers. Today when not given. */
    period?: { start: string; end: string };
  },
): Promise<{ invoiceId: string; totalCents: number; taxCents: number }> {
  const linked = p.items.some((i) => i.visitId || i.addonChargeId);
  if (linked) {
    const { checkInvoiceLinks } = await import("@/lib/visit-invoicing.server");
    await checkInvoiceLinks(supabase, p.orgId, p.clientId, p.items);
  }
  const subtotal = p.items.reduce((s, i) => s + i.amountCents, 0);
  const nowIso = new Date().toISOString();
  // Due date = issued date + the org's payment terms. (A DB trigger also
  // fills due_on for paths that don't set it, e.g. the generate RPCs.)
  //
  // Both dates are the ORG's day. They were the UTC day, so an invoice made
  // at 8 PM in California was dated tomorrow and due a day late.
  const { data: org } = await supabase
    .from("organizations")
    .select("invoice_net_days, timezone, sales_tax_rate_bps, sales_tax_label")
    .eq("id", p.orgId)
    .single();
  // Sales tax, by the same rule the billing run's set_invoice_totals applies:
  // the org's rate unless the client is exempt, snapshotted onto the invoice,
  // on the whole subtotal, rounded once. At the default rate of 0 the totals
  // below are exactly the subtotal, which is what this path always wrote.
  const { data: taxClient } = await supabase
    .from("clients")
    .select("tax_exempt")
    .eq("id", p.clientId)
    .maybeSingle();
  const totals = invoiceTotals(
    subtotal,
    effectiveTaxRateBps(
      (org as { sales_tax_rate_bps?: number | null } | null)?.sales_tax_rate_bps,
      (taxClient as { tax_exempt?: boolean | null } | null)?.tax_exempt,
    ),
    (org as { sales_tax_label?: string | null } | null)?.sales_tax_label,
  );
  const total = totals.totalCents;
  const today = orgToday(org?.timezone || DEFAULT_ORG_TIMEZONE);
  const netDays = org?.invoice_net_days ?? 15;
  const dueOn = addDaysToDay(today, netDays);
  // Every line goes in one request with the same keys. A bulk insert whose
  // rows have different keys is sent with the union of the columns and NULL
  // where a row had none, so "Full groom x1" beside "Add-on x2" wrote a NULL
  // quantity (#606). A line that is only a total is one of itself.
  const lineRow = (i: ManualInvoiceItem) => ({
    description: i.description,
    amount_cents: i.amountCents,
    visit_id: i.visitId ?? null,
    addon_charge_id: i.addonChargeId ?? null,
    quantity: i.quantity ?? 1,
    unit_amount_cents: i.quantity !== undefined ? i.unitAmountCents! : null,
  });
  // The invoice, its lines, the add-on claims and the check that no visit was
  // billed elsewhere meanwhile, in one transaction. The number is taken from
  // the org's counter inside it, so a failed save rolls the number back too.
  const { data: created, error: iErr } = await supabase.rpc("create_manual_invoice", {
    _invoice: newInvoice({
      organization_id: p.orgId,
      client_id: p.clientId,
      kind: "postpaid",
      status: "open",
      subtotal_cents: totals.subtotalCents,
      tax_rate_bps: totals.taxRateBps,
      tax_cents: totals.taxCents,
      tax_label: totals.taxLabel,
      total_cents: total,
      period_start: p.period?.start ?? today,
      period_end: p.period?.end ?? today,
      issued_at: nowIso,
      due_on: dueOn,
      notes: p.notes ?? "Manual invoice",
    }),
    _lines: p.items.map(lineRow),
  });
  if (iErr) throw new Error(iErr.message);
  const invoiceId = created as string;
  const { logActivity } = await import("@/lib/activity.server");
  await logActivity(supabase, {
    orgId: p.orgId,
    clientId: p.clientId,
    actorUserId: p.userId,
    ...(p.userId ? {} : { actorLabel: "Client portal" }),
    kind: "invoice.created",
    summary: `Created ${p.activityLabel ?? "manual invoice"} ${await invoiceRef(supabase, invoiceId)} for $${(total / 100).toFixed(2)}`,
  });
  return { invoiceId, totalCents: total, taxCents: totals.taxCents };
}
