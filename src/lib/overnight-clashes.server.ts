// The office is warned when a sitter's visit falls inside one of their
// overnights (overnight_clashes, migration 20261017030000). Asked after the
// write, so the warning describes what was saved. A failed check is no
// warning rather than a failed save.

import { overnightClashSentence, type OvernightClash } from "@/lib/stays";

export async function overnightClashWarning(
  supabase: any,
  on: { visitIds: readonly string[] } | { stayId: string },
): Promise<string | null> {
  const { data, error } =
    "stayId" in on
      ? await supabase.rpc("stay_sitter_clashes", { _stay_id: on.stayId })
      : on.visitIds.length === 0
        ? { data: [], error: null }
        : await supabase.rpc("overnight_clashes", { _visit_ids: [...on.visitIds] });
  if (error) {
    console.warn("overnight clash check failed");
    return null;
  }
  return overnightClashSentence(data as OvernightClash[] | null);
}
