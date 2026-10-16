/** What My Day adds to a pet sitting stop (#411): the stay (sit_visit_facts,
 *  because a tech cannot read plans) and the care log so far.
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

const one = <T,>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export async function withSitDay<V extends { id: string; services?: unknown }>(
  supabase: SupabaseClient<Database>,
  visits: V[],
): Promise<(V & { sit_facts?: SitFacts | null; care_entries?: CareEntry[] })[]> {
  const ids = visits.filter((v) => isSitVisit(v as any)).map((v) => v.id);
  if (ids.length === 0) return visits;

  const facts = new Map<string, SitFacts>();
  const entries = new Map<string, CareEntry[]>();
  try {
    const { data, error } = await supabase.rpc("sit_visit_facts", { _visit_ids: ids });
    if (error) throw error;
    for (const r of (data ?? []) as SitFacts[]) facts.set(r.visit_id, r);
  } catch (e) {
    console.warn("sit_visit_facts failed; the sit cards will omit stay dates", e);
  }
  try {
    const { data, error } = await (supabase as any)
      .from("care_log")
      .select("id, visit_id, pet_id, kind, med_name, status, missed_reason, note, at, staff(display_name)")
      .in("visit_id", ids)
      .order("at");
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

  return visits.map((v) =>
    isSitVisit(v as any)
      ? { ...v, sit_facts: facts.get(v.id) ?? null, care_entries: entries.get(v.id) ?? [] }
      : v,
  );
}
