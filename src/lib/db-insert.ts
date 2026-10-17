import type { TablesInsert } from "@/integrations/supabase/types";

type InvoiceInsert = TablesInsert<"invoices">;
type QuoteInsert = TablesInsert<"quotes">;
type ClientPackageInsert = TablesInsert<"client_packages">;
type ServiceSizeRuleInsert = TablesInsert<"service_size_rules">;
type PetGroomNoteInsert = TablesInsert<"pet_groom_notes">;

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

// The BEFORE INSERT trigger copies `organization_id` from the service, whatever the caller sends.
export function newServiceSizeRule(
  row: Omit<ServiceSizeRuleInsert, "organization_id">,
): ServiceSizeRuleInsert {
  return row as ServiceSizeRuleInsert;
}

// The BEFORE INSERT trigger copies these from the visit, whatever the caller sends.
export function newPetGroomNote(
  row: Omit<PetGroomNoteInsert, "organization_id" | "groomed_on">,
): PetGroomNoteInsert {
  return row as PetGroomNoteInsert;
}
