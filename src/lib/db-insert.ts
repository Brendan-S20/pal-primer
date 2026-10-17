import type { TablesInsert } from "@/integrations/supabase/types";

type InvoiceInsert = TablesInsert<"invoices">;
type QuoteInsert = TablesInsert<"quotes">;

// The BEFORE INSERT trigger assigns `number` from the org's counter, whatever the caller sends.
export function newInvoice(row: Omit<InvoiceInsert, "number">): InvoiceInsert {
  return row as InvoiceInsert;
}

// The BEFORE INSERT trigger assigns `number` from the org's counter, whatever the caller sends.
export function newQuote(row: Omit<QuoteInsert, "number">): QuoteInsert {
  return row as QuoteInsert;
}
