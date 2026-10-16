/** Payment rails for a stay or its deposit. Other invoices keep the rails
 *  their existing callers offer. Fail closed if the lookup fails. */
export async function stayInvoicePaymentTypes(invoiceId: string, orgId: string, existing: string[]): Promise<string[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("stays").select("id")
    .eq("organization_id", orgId).or(`invoice_id.eq.${invoiceId},deposit_invoice_id.eq.${invoiceId}`).limit(1);
  if (error) throw new Error(error.message);
  return data?.length ? ["card"] : existing;
}
