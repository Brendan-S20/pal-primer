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
};

/** Insert an open invoice and its lines for a client the caller has already
 *  checked belongs to `orgId`. Shared by the New invoice dialog and by
 *  invoicing a quote's one-time charges, so both date the invoice on the
 *  org's day, apply its payment terms, and clean up after a failed line
 *  insert the same way. */
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
  },
): Promise<{ invoiceId: string; totalCents: number; taxCents: number }> {
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
  const { data: inv, error: iErr } = await supabase
    .from("invoices")
    .insert(
      newInvoice({
        organization_id: p.orgId,
        client_id: p.clientId,
        kind: "postpaid",
        status: "open",
        subtotal_cents: totals.subtotalCents,
        tax_rate_bps: totals.taxRateBps,
        tax_cents: totals.taxCents,
        tax_label: totals.taxLabel,
        total_cents: total,
        period_start: today,
        period_end: today,
        issued_at: nowIso,
        due_on: dueOn,
        notes: p.notes ?? "Manual invoice",
      }),
    )
    .select("id")
    .single();
  if (iErr) throw new Error(iErr.message);

  const { error: lErr } = await supabase.from("invoice_line_items").insert(
    p.items.map((i) => ({
      invoice_id: inv.id,
      description: i.description,
      amount_cents: i.amountCents,
      ...(i.quantity !== undefined
        ? { quantity: i.quantity, unit_amount_cents: i.unitAmountCents! }
        : {}),
    })),
  );
  if (lErr) {
    // Don't leave a headless invoice behind if the lines failed.
    await supabase.from("invoices").delete().eq("id", inv.id);
    throw new Error(lErr.message);
  }
  const { logActivity } = await import("@/lib/activity.server");
  await logActivity(supabase, {
    orgId: p.orgId,
    clientId: p.clientId,
    actorUserId: p.userId,
    ...(p.userId ? {} : { actorLabel: "Client portal" }),
    kind: "invoice.created",
    summary: `Created ${p.activityLabel ?? "manual invoice"} ${await invoiceRef(supabase, String(inv.id))} for $${(total / 100).toFixed(2)}`,
  });
  return { invoiceId: inv.id as string, totalCents: total, taxCents: totals.taxCents };
}
