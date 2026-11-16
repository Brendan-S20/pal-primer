// Completing a visit for a client the owner's BLOCK rule holds (#851 follow-up).
//
// The owner, 2026-11-10, verbatim: "No, provide a warning as to why they were
// blocked." So BLOCK never stops a Complete. Every Complete button asks the
// server first (getCompletionBlockWarning), and when the visit is held, shows
// the reason, who set the rule and when, and lets the person go on or back
// out. Continue completes exactly as before; Cancel changes nothing.
//
// What "blocked" means here is what #729 built and #851 hardened: the owner
// set vaccine_start_rule = 'block', and a pet on this visit is missing a
// required vaccine or has one that expired (visit_missing_vaccines). There is
// no free-text reason column anywhere in the schema, so the REASON is that
// list, pet by pet, in the database's own words, and WHO and WHEN are the
// owner's change in org_vaccine_policy_changes.
//
// The completion records it: the visit.completed entry on the client's
// timeline (activity_log, through logActivity) carries `blocked_completion`
// with the reason as it was at that moment, who completed it, when, and
// whether the warning was shown and acknowledged. The server works the block
// out for itself, so a completion from a client that never asked (an old app,
// a queued action replayed from before this shipped) is still recorded, as
// not acknowledged.

import type { MissingVaccine } from "@/lib/pet-safety";

export type CompletionBlockWarning = {
  /** What is missing, per pet, as visit_missing_vaccines returned it. */
  missing: MissingVaccine[];
  /** When the owner turned the BLOCK rule on, ISO; null when not recorded. */
  setAt: string | null;
  /** Who turned it on, when the caller may read the trail (the office).
   *  A tech gets null, and the dialog says "the owner", which is the only
   *  person set_vaccine_start_rule lets set it. */
  setBy: string | null;
};

/** "Rex: rabies, bordetella; Luna: rabies". Empty when nothing is listed. */
export function completionBlockReason(w: Pick<CompletionBlockWarning, "missing"> | null): string {
  const byPet = new Map<string, string[]>();
  for (const m of w?.missing ?? []) {
    const name = (m.dog_name ?? "").trim();
    const vaccine = (m.vaccine ?? "").trim();
    if (!name && !vaccine) continue;
    const list = byPet.get(name) ?? [];
    if (vaccine && !list.includes(vaccine)) list.push(vaccine);
    byPet.set(name, list);
  }
  return [...byPet]
    .map(([name, vaccines]) =>
      name ? (vaccines.length ? `${name}: ${vaccines.join(", ")}` : name) : vaccines.join(", "),
    )
    .join("; ");
}

/** What the timeline and the dialog say when the block has no reason. The
 *  dialog's own copy is t("completionBlock.noReason"), the same sentence. */
export const COMPLETION_BLOCK_NO_REASON = "This client is blocked (no reason given)";

/** The `blocked_completion` meta on the visit.completed activity entry. */
export function blockedCompletionMeta(
  w: CompletionBlockWarning,
  input: { acknowledged: boolean; completedBy: string; completedAt: string },
) {
  return {
    reason: completionBlockReason(w) || null,
    missing: w.missing.map((m) => ({ dog_id: m.dog_id, dog_name: m.dog_name, vaccine: m.vaccine })),
    rule_set_at: w.setAt,
    rule_set_by: w.setBy,
    warning_acknowledged: input.acknowledged,
    completed_by: input.completedBy,
    completed_at: input.completedAt,
  };
}

/** The sentence appended to the timeline summary. */
export function blockedCompletionSummary(w: CompletionBlockWarning, acknowledged: boolean): string {
  const reason = completionBlockReason(w);
  const why = reason ? `Blocked: ${reason}` : COMPLETION_BLOCK_NO_REASON;
  return acknowledged
    ? ` despite the block, after the warning (${why})`
    : ` while the client was blocked; no warning was shown (${why})`;
}
