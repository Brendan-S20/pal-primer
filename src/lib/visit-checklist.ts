/** The visit checklist: what the owner asks a tech to confirm on every visit.
 *
 *  Jobber calls these job forms. A product review found the field app had
 *  none: a tech could leave a note, take a photo of the gate and press
 *  Complete, and nothing asked "all areas walked?" or "gate latched?".
 *
 *  One shape, in three places, which is why it lives here:
 *
 *    organizations.visit_checklist  the owner's list: `ChecklistItem[]`
 *    visits.visit_checklist         what the tech answered: `ChecklistAnswer[]`,
 *                                   written by complete_visit, with each item's
 *                                   LABEL copied as it read that day, so editing
 *                                   the list later does not rewrite history
 *    the offline queue              the ids the tech checked, replayed as the
 *                                   `_checked_items` complete_visit takes
 *
 *  The limits are the database's (`visit_checklist_is_valid`), spelled out
 *  once so the settings editor refuses what the CHECK would refuse, with a
 *  sentence instead of a constraint name. */

export const MAX_CHECKLIST_ITEMS = 12;
export const MAX_CHECKLIST_LABEL = 120;
export const MAX_CHECKLIST_ID = 64;

export type ChecklistItem = { id: string; label: string; required: boolean };
export type ChecklistAnswer = ChecklistItem & { checked: boolean };

/** The set an owner can add with one tap. Required by default: an item a tech
 *  can skip past is one nobody reads, and the owner can untick it. */
export const SUGGESTED_CHECKLIST: readonly { label: string; required: boolean }[] = [
  { label: "All areas walked", required: true },
  { label: "Waste bagged and disposed", required: true },
  { label: "Gate latched", required: true },
  { label: "Water bowl checked", required: false },
];

/** A fresh id for a new item. Never derived from the label: a renamed item
 *  keeps its id, which is how a queued answer still finds it. */
export function newChecklistItemId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The owner's checklist out of whatever the org row holds.
 *
 * Defensive on purpose. It is read from the persisted `["my-org"]` query,
 * which may be a copy written by an older build, or null for an org that
 * existed before the column did. Anything that is not an item is dropped
 * rather than drawn as a blank row a tech cannot satisfy.
 */
export function parseChecklist(raw: unknown): ChecklistItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: ChecklistItem[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const { id, label, required } = r as Record<string, unknown>;
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    if (typeof label !== "string" || !label.trim()) continue;
    seen.add(id);
    out.push({ id, label: label.trim(), required: required === true });
  }
  return out.slice(0, MAX_CHECKLIST_ITEMS);
}

/** What a visit recorded, out of `visits.visit_checklist`. Null when the visit
 *  has no checklist: completed before one existed, or by a path that does not
 *  ask (the office, the end-of-day close-out). */
export function parseAnswers(raw: unknown): ChecklistAnswer[] | null {
  if (!Array.isArray(raw)) return null;
  const items = parseChecklist(raw);
  const byId = new Map(
    raw
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
      .map((r) => [r.id, r.checked === true] as const),
  );
  return items.map((i) => ({ ...i, checked: byId.get(i.id) === true }));
}

/** The required items not yet checked, in the owner's order. Empty means the
 *  checklist does not stand in the way of Complete. complete_visit asks the
 *  same question of the same list and refuses on the same answer. */
export function missingRequired(
  items: readonly ChecklistItem[],
  checkedIds: readonly string[],
): ChecklistItem[] {
  const checked = new Set(checkedIds);
  return items.filter((i) => i.required && !checked.has(i.id));
}

/** The answers as the tech gave them, for the screen. The database builds its
 *  own copy from the owner's list; this is the same shape. */
export function answersFor(
  items: readonly ChecklistItem[],
  checkedIds: readonly string[],
): ChecklistAnswer[] {
  const checked = new Set(checkedIds);
  return items.map((i) => ({ ...i, checked: checked.has(i.id) }));
}

/** The labels of the items that were checked, in the owner's order: what the
 *  completion email lists when the owner has turned that on. */
export function checkedLabels(answers: readonly ChecklistAnswer[] | null): string[] {
  return (answers ?? []).filter((a) => a.checked).map((a) => a.label);
}

/** Why the owner's draft cannot be saved, or null when it can. The same rules
 *  as `visit_checklist_is_valid`, in words. */
export function checklistProblem(items: readonly ChecklistItem[]): string | null {
  if (items.length > MAX_CHECKLIST_ITEMS) {
    return `A checklist can have up to ${MAX_CHECKLIST_ITEMS} items.`;
  }
  const ids = new Set<string>();
  for (const i of items) {
    if (!i.label.trim()) return "Every item needs a label.";
    if (i.label.trim().length > MAX_CHECKLIST_LABEL) {
      return `Keep each item under ${MAX_CHECKLIST_LABEL} characters.`;
    }
    if (!i.id || i.id.length > MAX_CHECKLIST_ID || ids.has(i.id)) return "Two items share an id.";
    ids.add(i.id);
  }
  return null;
}
