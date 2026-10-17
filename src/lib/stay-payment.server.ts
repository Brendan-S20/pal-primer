/** Payment rails for a stay invoice or its deposit: card only. Every other
 *  invoice keeps the rails its caller already offers. If the lookup fails, the
 *  invoice keeps its usual rails, so a pet-waste payment never fails because
 *  of this check. */
export async function stayInvoicePaymentTypes(
  invoiceId: string,
  orgId: string,
  existing: string[],
): Promise<string[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("stays")
    .select("id")
    .eq("organization_id", orgId)
    .or(`invoice_id.eq.${invoiceId},deposit_invoice_id.eq.${invoiceId}`)
    .limit(1);
  if (error) {
    console.error("stay payment rails lookup failed", invoiceId, error.message);
    return existing;
  }
  return data?.length ? ["card"] : existing;
}
