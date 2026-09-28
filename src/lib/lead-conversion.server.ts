// The database half of converting a lead: find it, refuse it if it has
// already been converted, and record which client it became. Shared by the
// leads page's lookup (leads.functions.ts) and the wizard's save
// (onboardClient in clients.functions.ts), so the rule for "already converted"
// is the one in lead-conversion.ts, asked in one place.

import { leadConversionState, type ConvertibleLead } from "@/lib/lead-conversion";

export const CONVERTIBLE_LEAD_COLUMNS =
  "id, organization_id, name, email, phone, company, location, dog_count, frequency, message, source, status, converted_client_id";

/** The lead, in the caller's organization, or an error that says why not.
 *  RLS already scopes leads to owners and office managers of the lead's org;
 *  the organization check is here as well so the rule does not rest on a
 *  policy in another file. */
export async function loadLeadForConversion(
  supabase: any,
  orgId: string,
  leadId: string,
): Promise<ConvertibleLead> {
  const { data, error } = await supabase
    .from("leads")
    .select(CONVERTIBLE_LEAD_COLUMNS)
    .eq("id", leadId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data || data.organization_id !== orgId) throw new Error("That lead was not found.");
  const { organization_id: _org, ...lead } = data;
  return lead as ConvertibleLead;
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
