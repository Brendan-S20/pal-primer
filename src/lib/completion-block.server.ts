// The server's half of the completion block warning (src/lib/completion-block.ts).
//
// Read through the CALLER's client, so RLS decides what they see:
// visit_missing_vaccines answers only the visit's tech or the business's
// office (42501 otherwise), and org_vaccine_policy_changes is readable by the
// office only, so a tech gets setBy null and the dialog says "the owner".
//
// Never throws. A lookup that fails must not stop a Complete (BLOCK never
// does, by the owner's decision), so a failure is logged and read as "not
// blocked": the visit completes, and the timeline simply has no block line.

import type { CompletionBlockWarning } from "@/lib/completion-block";
import type { MissingVaccine } from "@/lib/pet-safety";

type Client = { from: (table: string) => any; rpc: (fn: string, args?: any) => any };

export async function completionBlockWarning(
  db: Client,
  visitId: string,
): Promise<CompletionBlockWarning | null> {
  try {
    const { data: v } = await db
      .from("visits")
      .select("organization_id")
      .eq("id", visitId)
      .maybeSingle();
    if (!v?.organization_id) return null;
    const { data: org } = await db
      .from("organizations")
      .select("vaccine_start_rule, vaccine_start_rule_set_at")
      .eq("id", v.organization_id)
      .maybeSingle();
    if (org?.vaccine_start_rule !== "block") return null;

    const { data: rows, error } = await db.rpc("visit_missing_vaccines", { _visit_id: visitId });
    if (error) throw error;
    const missing = (rows ?? []) as MissingVaccine[];
    if (missing.length === 0) return null;

    // Who turned BLOCK on, and when: the newest change to 'block'. The
    // office can read it; a tech's read comes back empty.
    let setBy: string | null = null;
    let setAt: string | null = org.vaccine_start_rule_set_at ?? null;
    const { data: change } = await db
      .from("org_vaccine_policy_changes")
      .select("changed_by, changed_at")
      .eq("organization_id", v.organization_id)
      .eq("new_value", "block")
      .order("changed_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (change) {
      setAt = change.changed_at ?? setAt;
      if (change.changed_by) {
        const { data: who } = await db
          .from("staff")
          .select("display_name")
          .eq("user_id", change.changed_by)
          .eq("organization_id", v.organization_id)
          .maybeSingle();
        setBy = who?.display_name ?? null;
      }
    }
    return { missing, setAt, setBy };
  } catch (e) {
    console.warn("completion block lookup failed; the Complete goes ahead unwarned", visitId, e);
    return null;
  }
}
