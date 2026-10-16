import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { serviceLinesOrDefault } from "@/lib/service-lines";
import { orgToday } from "@/lib/org-day";
import type { VaccineRule } from "@/lib/vaccines";
type Db = SupabaseClient<Database>;

export async function loadVaccineSettings(db: Db, orgId: string) {
  const { data, error } = await db.from("organizations")
    .select("service_lines, vaccine_rule, required_vaccines, timezone").eq("id", orgId).single();
  if (error) throw new Error(error.message);
  return { enabled: serviceLinesOrDefault(data.service_lines).includes("mobile_grooming"),
    rule: data.vaccine_rule as VaccineRule, required: data.required_vaccines, today: orgToday(data.timezone) };
}

