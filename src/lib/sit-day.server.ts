/** What My Day adds to a pet sitting stop (#411): the stay (sit_visit_facts,
 *  because a tech cannot read plans), the care log so far, and how to get in.
 *
 *  A stay visit's gate code, lock box code, key and alarm details come only
 *  from stay_access_codes (migration 20261024080500): the stay's sitter,
 *  from the day before its first visit to its last, and every read is
 *  logged. Whatever the day's query or property_access_codes put on the
 *  property is replaced, so a sit card never shows a code by another path.
 *
 *  Nothing is asked for a day with no pet sitting stop, so a pet-waste or
 *  walking day costs exactly the requests it cost before. A failure leaves
 *  the card without stay dates or past entries rather than the page without
 *  a day. */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { isSitVisit, type CareEntry, type SitFacts } from "@/lib/sit-day";

type CareRow = {
  id: string;
  visit_id: string;
  pet_id: string | null;
  kind: CareEntry["kind"];
  med_name: string | null;
  status: CareEntry["status"];
  missed_reason: string | null;
  note: string | null;
  at: string;
  staff: { display_name: string | null } | { display_name: string | null }[] | null;
};

const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export async function withSitDay<
  V extends { id: string; services?: unknown; properties?: unknown },
>(
  supabase: SupabaseClient<Database>,
  visits: V[],
): Promise<
  (V & {
    sit_facts?: SitFacts | null;
    care_entries?: CareEntry[];
    stay_codes_shown?: boolean;
  })[]
> {
  const ids = visits.filter((v) => isSitVisit(v as any)).map((v) => v.id);
  if (ids.length === 0) return visits;

  const facts = new Map<string, SitFacts>();
  const entries = new Map<string, CareEntry[]>();
  // Both at once: neither waits on the other.
  const [factsRes, careRes] = await Promise.allSettled([
    supabase.rpc("sit_visit_facts", { _visit_ids: ids }),
    (supabase as any)
      .from("care_log")
      .select(
        "id, visit_id, pet_id, kind, med_name, status, missed_reason, note, at, staff(display_name)",
      )
      .in("visit_id", ids)
      .order("at"),
  ]);
  try {
    if (factsRes.status === "rejected") throw factsRes.reason;
    const { data, error } = factsRes.value;
    if (error) throw error;
    for (const r of (data ?? []) as SitFacts[]) facts.set(r.visit_id, r);
  } catch (e) {
    console.warn("sit_visit_facts failed; the sit cards will omit stay dates", e);
  }
  try {
    if (careRes.status === "rejected") throw careRes.reason;
    const { data, error } = careRes.value;
    if (error) throw error;
    for (const r of (data ?? []) as CareRow[]) {
      const list = entries.get(r.visit_id) ?? [];
      list.push({
        id: r.id,
        pet_id: r.pet_id,
        kind: r.kind,
        med_name: r.med_name,
        status: r.status,
        missed_reason: r.missed_reason,
        note: r.note,
        at: r.at,
        given_by_name: one(r.staff)?.display_name ?? null,
      });
      entries.set(r.visit_id, list);
    }
  } catch (e) {
    console.warn("care log lookup failed; the sit cards will start empty", e);
  }

  const codes = new Map<string, StayCodes>();
  const stayIds = [...new Set([...facts.values()].map((f) => f.stay_id))];
  if (stayIds.length > 0) {
    const { data, error } = await supabase.rpc("stay_access_codes", { _stay_ids: stayIds });
    if (error) console.warn("stay access codes could not be loaded");
    for (const r of data ?? []) codes.set(r.stay_id, r);
  }

  return visits.map((v) => {
    if (!isSitVisit(v as any)) return v;
    const f = facts.get(v.id) ?? null;
    const c = f ? codes.get(f.stay_id) : undefined;
    const property =
      v.properties && typeof v.properties === "object" && !Array.isArray(v.properties)
        ? {
            ...(v.properties as object),
            gate_code: c?.gate_code ?? null,
            lock_box_code: c?.lock_box_code ?? null,
            key_location: c?.key_location ?? null,
            key_tag: c?.key_tag ?? null,
            alarm_notes: c?.alarm_notes ?? null,
          }
        : v.properties;
    return {
      ...v,
      properties: property as V["properties"],
      sit_facts: f,
      care_entries: entries.get(v.id) ?? [],
      stay_codes_shown: !!c,
    };
  });
}

type StayCodes = {
  stay_id: string;
  gate_code: string | null;
  lock_box_code: string | null;
  key_location: string | null;
  key_tag: string | null;
  alarm_notes: string | null;
};
