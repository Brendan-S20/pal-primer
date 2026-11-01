// The server half of booking-dates.ts: reads the business's time zone and
// throws the plain-language refusal. Every booking and reschedule path calls
// this before it writes, so a past day typed into a stale form, an old tab or
// a direct request is refused the same way the picker refuses it (#654).
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";
import { pastDayRefusal } from "@/lib/booking-dates";

export async function orgTodayFor(
  supabase: SupabaseClient<Database>,
  orgId: string,
): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("timezone")
    .eq("id", orgId)
    .maybeSingle();
  return orgToday((data as { timezone?: string | null } | null)?.timezone || DEFAULT_ORG_TIMEZONE);
}

export async function refusePastDay(
  supabase: SupabaseClient<Database>,
  orgId: string,
  day: string,
): Promise<void> {
  const refusal = pastDayRefusal(day, await orgTodayFor(supabase, orgId));
  if (refusal) throw new Error(refusal);
}
