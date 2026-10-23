import type { TablesInsert } from "@/integrations/supabase/types";

type InvoiceInsert = TablesInsert<"invoices">;
type QuoteInsert = TablesInsert<"quotes">;
type ClientPackageInsert = TablesInsert<"client_packages">;

// The BEFORE INSERT trigger assigns `number` from the org's counter, whatever the caller sends.
export function newInvoice(row: Omit<InvoiceInsert, "number">): InvoiceInsert {
  return row as InvoiceInsert;
}

// The BEFORE INSERT trigger assigns `number` from the org's counter, whatever the caller sends.
export function newQuote(row: Omit<QuoteInsert, "number">): QuoteInsert {
  return row as QuoteInsert;
}

// The BEFORE INSERT trigger copies these from the service package, whatever the caller sends.
export function newClientPackage(
  row: Omit<
    ClientPackageInsert,
    "name" | "price_cents" | "purchased_on" | "service_id" | "sessions_count"
  >,
): ClientPackageInsert {
  return row as ClientPackageInsert;
}
