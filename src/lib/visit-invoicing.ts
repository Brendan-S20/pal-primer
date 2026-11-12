// Invoice a visit when it is completed (#605, decision D2).
//
// The postpaid billing run (admin_generate_invoice_for_client, called by
// run_billing_cycles every night and by Generate from visits) bills every
// completed postpaid visit that no invoice line points at:
//
//     LEFT JOIN public.invoice_line_items li ON li.visit_id = v.id
//     WHERE ... li.id IS NULL
//
// and every PENDING add-on charge. A hand-made invoice never set visit_id and
// never touched the add-on charges, so the run billed the same work a second
// time. The fix is the link, not a new rule in the run: a line that names the
// visit takes it out of the run, and an add-on charge marked invoiced against
// a line is no longer pending.
//
// This file is the pure half: which visits can be invoiced by hand, and what
// their lines say. The words and amounts are the run's own, so an invoice made
// at completion reads the same as one the cycle would have made.

/** The visit columns the rules below read. */
export type BillableVisit = {
  id: string;
  scheduled_on: string;
  status: string;
  skip_billable: boolean | null;
  skip_charge_cents: number | null;
  skip_reason_code: string | null;
  is_deepclean: boolean | null;
  deepclean_charge_cents: number | null;
  price_cents: number | null;
  client_package_id: string | null;
  subscription: { price_cents: number | null; billing_cadence: string | null } | null;
  service_name: string | null;
  street: string | null;
};

/** A pending add-on charge, as the run reads it. */
export type PendingAddon = {
  id: string;
  visit_id: string | null;
  description: string;
  occurred_on: string;
  quantity: number;
  amount_cents: number;
};

/** An invoice line that points at a visit, with its invoice. */
export type VisitLink = {
  visit_id: string;
  invoice: { id: string; number: number | null; status: string };
};

/** One line of the invoice a visit would get. `visitId` is set on the line
 *  that bills the visit itself; `addonChargeId` on a line that bills one
 *  add-on charge. Both are what keep the billing run off this work. */
export type VisitInvoiceLine = {
  description: string;
  amountCents: number;
  visitId?: string;
  addonChargeId?: string;
};

/** public.service_line_item_name: the business's own service name, or
 *  "Service" for the seeded pet-waste service and a visit with none. */
export function serviceLineItemName(name: string | null | undefined): string {
  const n = (name ?? "").trim();
  return n === "" || n.toLowerCase() === "pet waste removal" ? "Service" : n;
}

/** Whether the run would ever bill this visit at all: completed, or skipped
 *  and billable. Anything else has nothing to invoice. */
export function isBillableStatus(v: Pick<BillableVisit, "status" | "skip_billable">): boolean {
  return v.status === "completed" || (v.status === "skipped" && v.skip_billable === true);
}

/** The live invoice a visit is already on, if any. A line on a void invoice
 *  does not count: voiding gave the money back, so the work is unbilled. */
export function liveInvoiceFor(visitId: string, links: VisitLink[]): VisitLink["invoice"] | null {
  const live = links.filter((l) => l.visit_id === visitId && l.invoice.status !== "void");
  return live.length ? live[0].invoice : null;
}

/** Why this visit cannot be invoiced by hand, or null when it can. */
export function visitInvoiceBlocker(
  v: BillableVisit,
  links: VisitLink[],
  label: (inv: { id: string; number: number | null }) => string,
): string | null {
  if (!isBillableStatus(v)) return "Only a completed visit can be invoiced.";
  const on = liveInvoiceFor(v.id, links);
  if (on) return `This visit is already on invoice ${label(on)}.`;
  if (v.client_package_id) return "This lesson is billed on its package invoice.";
  if (v.subscription?.billing_cadence === "prepaid") {
    return "This visit is prepaid. It was paid from the client's balance when it was completed.";
  }
  return null;
}

/** The lines the billing run would write for this visit, in its words:
 *  the visit, the deep-clean surcharge when there is one, and each pending
 *  add-on charged with the visit. */
export function linesForVisit(v: BillableVisit, addons: PendingAddon[]): VisitInvoiceLine[] {
  const where = v.street ? ` - ${v.street}` : "";
  const price = v.price_cents ?? v.subscription?.price_cents ?? 0;
  const lines: VisitInvoiceLine[] = [];
  if (v.status === "skipped") {
    lines.push({
      visitId: v.id,
      description: `Skipped visit ${v.scheduled_on} (${v.skip_reason_code ?? "other"})`,
      amountCents: v.skip_charge_cents ?? 0,
    });
  } else if (v.is_deepclean) {
    lines.push({
      visitId: v.id,
      description: `Deep clean on ${v.scheduled_on}${where}`,
      amountCents: price,
    });
  } else {
    lines.push({
      visitId: v.id,
      description: `${serviceLineItemName(v.service_name)} on ${v.scheduled_on}${where}`,
      amountCents: price,
    });
  }
  if (v.status === "completed" && v.is_deepclean && (v.deepclean_charge_cents ?? 0) > 0) {
    lines.push({
      description: `Seasonal deep-clean surcharge (${v.scheduled_on})`,
      amountCents: v.deepclean_charge_cents!,
    });
  }
  for (const a of addons) {
    if (a.visit_id !== v.id) continue;
    lines.push(addonLine(a));
  }
  return lines;
}

/** One pending add-on charge as an invoice line, worded as the run words it. */
export function addonLine(a: PendingAddon): VisitInvoiceLine {
  return {
    addonChargeId: a.id,
    description: `${a.description} (${a.occurred_on})${a.quantity > 1 ? ` x ${a.quantity}` : ""}`,
    amountCents: a.amount_cents,
  };
}

/** What, beyond the visit itself, decides whether completing it invoices it
 *  (#859). The billing run reads the same three: it skips an inactive client
 *  and an org with automatic invoicing off, and bills an after-each-visit
 *  client through today rather than at the end of a period. */
export type CompletionBilling = {
  billingFrequency: string | null;
  clientActive: boolean | null;
  autoInvoiceEnabled: boolean | null;
};

/** Whether completing this visit should invoice it there and then (#605,
 *  decision D2: invoice at completion; #859). Only a completed visit on a
 *  POSTPAID plan whose client is billed after each visit. A prepaid visit was
 *  paid from the balance by finalize_visit_completion and gets no invoice; a
 *  weekly or monthly client is billed for the period by the run; a package
 *  lesson is on its package invoice. Whether the visit is already on a live
 *  invoice is visitInvoiceBlocker's question, asked separately. */
export function invoicesAtCompletion(v: BillableVisit, c: CompletionBilling): boolean {
  return (
    v.status === "completed" &&
    v.subscription?.billing_cadence === "postpaid" &&
    !v.client_package_id &&
    c.billingFrequency === "after_each_visit" &&
    c.clientActive !== false &&
    c.autoInvoiceEnabled === true
  );
}

/** How many void invoices have billed this visit. Each void gives the work
 *  back, so it is the visit's billing GENERATION: the first invoice is
 *  generation 0, the one made after voiding it generation 1. */
export function voidedInvoiceCount(visitId: string, links: VisitLink[]): number {
  return new Set(
    links
      .filter((l) => l.visit_id === visitId && l.invoice.status === "void")
      .map((l) => l.invoice.id),
  ).size;
}

/** The billing frequency a new client is saved with (#859). The new-client
 *  form offers a postpaid plan as "Bill after each visit", so that is what
 *  the client is billed on: invoiced at completion, not on the monthly run.
 *  A prepaid plan, or no plan, leaves the column's default alone. Weekly,
 *  monthly, quarterly and yearly stay a choice the office makes on the
 *  client afterwards (Edit client -> Billing frequency). */
export function billingFrequencyForNewClient(
  planCadence: "postpaid" | "prepaid" | null | undefined,
): "after_each_visit" | undefined {
  return planCadence === "postpaid" ? "after_each_visit" : undefined;
}
