// Writes an office cash tip onto the payment it came with. See office-tip.ts.
//
// Service role, because payments have no UPDATE policy: a payment row is
// written once by record_invoice_payment or the Stripe webhook and is not a
// thing a signed-in user edits. The caller has already been checked for
// manage_client_billing, and the row is narrowed to the payment that call
// just wrote, in the caller's organization, with no tip on it yet.

export async function recordOfficeTip(p: {
  orgId: string;
  invoiceId: string;
  paymentId: string;
  tipCents: number;
}): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Who the tip is for: the tech on the most recent completed visit billed on
  // this invoice, the same rule a card tip uses (tip_staff_for_invoice).
  let tipStaffId: string | null = null;
  try {
    const { data: staffId, error } = await (supabaseAdmin as any).rpc("tip_staff_for_invoice", {
      _invoice_id: p.invoiceId,
    });
    if (error) throw error;
    tipStaffId = typeof staffId === "string" && staffId ? staffId : null;
  } catch (e) {
    console.warn("tip attribution failed; recording the tip unattributed", p.invoiceId, e);
  }
  const { error } = await (supabaseAdmin as any)
    .from("payments")
    .update({ tip_cents: p.tipCents, tip_staff_id: tipStaffId })
    .eq("id", p.paymentId)
    .eq("organization_id", p.orgId)
    .eq("invoice_id", p.invoiceId)
    .eq("tip_cents", 0)
    .is("stripe_payment_intent_id", null);
  // Thrown, not logged: the payment is recorded either way, and the office
  // must hear that the tip is not, rather than read "Recorded".
  if (error) throw new Error(`The payment was recorded, but the tip was not: ${error.message}`);
}
