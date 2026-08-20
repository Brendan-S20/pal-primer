// "Was this add-on ever actually billed, and where?"
//
// `addon_charges.invoice_line_item_id` is set by
// `admin_generate_invoice_for_client` when a pending charge becomes a line on
// an invoice, and until now nothing followed it in either direction. The charge
// row said `status = 'invoiced'`, which answers WHETHER; nothing answered
// WHICH. When a client rings up about a $75 add-on on a $340 invoice, "it was
// billed" is not an answer — the person on the phone has to open invoices one
// by one until they find the line, and the pointer that would have told them
// was sitting in the row they were already looking at.
//
// Pure so the wording is testable: the honest cases here are the awkward ones
// (billed but the line is gone, paid from credit and never invoiced at all),
// and those are exactly the ones a vague label would paper over.

export type AddonChargeBillingRow = {
  status: string;
  invoice_line_item_id?: string | null;
  credit_ledger_id?: string | null;
  /** Resolved by the server function from the line item. */
  billed_invoice_id?: string | null;
  billed_invoice_status?: string | null;
};

export type AddonBillingTrail = {
  label: string;
  /** The invoice to link to, when there is one to link to. */
  invoiceId: string | null;
  /** Set when the record cannot answer the question it exists to answer. */
  warning: string | null;
};

/** The app's short form for an invoice, matching the payments list. */
export function shortInvoiceRef(invoiceId: string): string {
  return `#${invoiceId.slice(0, 8)}`;
}

export function addonBillingTrail(charge: AddonChargeBillingRow): AddonBillingTrail {
  const invoiceId = charge.billed_invoice_id ?? null;

  if (charge.status === "voided") {
    return { label: "Voided, never billed", invoiceId: null, warning: null };
  }

  if (charge.status === "paid_from_credit") {
    // Prepaid clients are debited immediately, so there is no invoice line to
    // point at and saying "billed on invoice …" would be a lie.
    return {
      label: "Paid from prepaid credit, not on an invoice",
      invoiceId: null,
      warning: null,
    };
  }

  if (charge.status === "invoiced") {
    if (invoiceId) {
      const paid = charge.billed_invoice_status === "paid";
      return {
        label: `Billed on invoice ${shortInvoiceRef(invoiceId)}${paid ? " (paid)" : ""}`,
        invoiceId,
        warning: null,
      };
    }
    // Two different broken states, and they need different answers. The pointer
    // still set but unresolvable means the line exists and something stopped us
    // reading it; the pointer gone means the line was deleted (the FK is
    // ON DELETE SET NULL) and the trail is genuinely lost. Either way, do not
    // offer a link to an invoice nobody can open.
    if (charge.invoice_line_item_id) {
      return {
        label: "Billed",
        invoiceId: null,
        warning: "The invoice line it was billed on couldn't be read.",
      };
    }
    return {
      label: "Billed",
      invoiceId: null,
      warning: "The invoice line this was billed on no longer exists.",
    };
  }

  return { label: "Unbilled, lands on the next invoice", invoiceId: null, warning: null };
}
