// The database half of converting a lead: find it, refuse it if it has
// already been converted, and record which client it became. Shared by the
// leads page's lookup (leads.functions.ts) and the wizard's save
// (onboardClient in clients.functions.ts), so the rule for "already converted"
// is the one in lead-conversion.ts, asked in one place.

import { leadConversionState, leadPets, type ConvertibleLead } from "@/lib/lead-conversion";

export const CONVERTIBLE_LEAD_COLUMNS =
  "id, organization_id, name, email, phone, company, location, dog_count, frequency, message, source, status, converted_client_id";

/** The columns above, as a list, for projecting the row read below. */
const CONVERTIBLE_LEAD_KEYS = CONVERTIBLE_LEAD_COLUMNS.split(",").map((c) => c.trim());

/** The lead, in the caller's organization, or an error that says why not.
 *  RLS already scopes leads to owners and office managers of the lead's org;
 *  the organization check is here as well so the rule does not rest on a
 *  policy in another file.
 *
 *  Every column, then projected, rather than the list by name: the lead's
 *  service (`service_id`, the catalog) is read when the column is there and
 *  is nothing when it is not, so this works on a database from before that
 *  column and on one after it without a deploy in between. Naming it in the
 *  select would refuse the whole lead on the first. */
export async function loadLeadForConversion(
  supabase: any,
  orgId: string,
  leadId: string,
): Promise<ConvertibleLead> {
  const { data, error } = await supabase.from("leads").select("*").eq("id", leadId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.organization_id !== orgId) throw new Error("That lead was not found.");
  const lead: Record<string, unknown> = {};
  for (const k of CONVERTIBLE_LEAD_KEYS) if (k !== "organization_id") lead[k] = data[k] ?? null;
  lead.service_id = typeof data.service_id === "string" ? data.service_id : null;
  // The first visit's three answers (#527), read the same defensive way, so
  // the wizard can start from them (#657).
  lead.pets = leadPets(data.pets);
  lead.access_notes = typeof data.access_notes === "string" ? data.access_notes : null;
  lead.preferred_start_date =
    typeof data.preferred_start_date === "string" ? data.preferred_start_date : null;
  return lead as unknown as ConvertibleLead;
}

/** Throw unless this lead can still become a new client. */
export function assertConvertible(lead: ConvertibleLead): void {
  const state = leadConversionState(lead);
  if (state.kind === "linked") throw new Error(`${lead.name} is already a client.`);
  if (state.kind === "converted-unlinked")
    throw new Error(
      `${lead.name} is already marked converted. Change the lead's status first if they still need a client record.`,
    );
}

/** Record the conversion: status, time, and which client. Only on a lead that
 *  is not linked yet, so two tabs converting the same lead cannot move the
 *  link from the first client to the second. Returns whether it took. */
export async function markLeadConverted(
  supabase: any,
  leadId: string,
  clientId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from("leads")
    .update({
      status: "converted",
      converted_at: new Date().toISOString(),
      converted_client_id: clientId,
    })
    .eq("id", leadId)
    .is("converted_client_id", null)
    .select("id");
  if (error) {
    console.error("marking the lead converted failed", error);
    return false;
  }
  return (data?.length ?? 0) > 0;
}
