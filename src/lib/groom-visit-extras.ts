// What a groom card shows beside the pets (#412): the add-ons booked on this
// groom with whether the groomer has marked each one done, and whether the van
// can plug in or fill up at the address. Pure, so the rules are tested without
// a database; the reads are in groom-visit-extras.functions.ts.

export type GroomVisitAddon = {
  addonServiceId: string;
  name: string;
  quantity: number;
  /** False once the groomer marks it not done. Only done add-ons are billed. */
  done: boolean;
};

export type GroomVisitExtras = {
  visitId: string;
  /** Marks can change only while the groom is still scheduled or under way. */
  canMark: boolean;
  addons: GroomVisitAddon[];
  van: { power: boolean; water: boolean };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The plan's add-ons (subscriptions.groom_addons, a list of
 *  {addon_service_id, quantity, name}) against the visit's not-done list.
 *  Anything that is not a well-formed entry is left out rather than drawn as
 *  a blank row, and an add-on listed twice is shown once. */
export function groomAddonsOnVisit(
  planAddons: unknown,
  notDone: readonly string[] | null | undefined,
): GroomVisitAddon[] {
  if (!Array.isArray(planAddons)) return [];
  const skipped = new Set(notDone ?? []);
  const seen = new Set<string>();
  const out: GroomVisitAddon[] = [];
  for (const raw of planAddons) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const id = typeof item.addon_service_id === "string" ? item.addon_service_id : "";
    if (!UUID.test(id) || seen.has(id)) continue;
    const qty = Number(item.quantity);
    if (Number.isFinite(qty) && qty <= 0) continue;
    seen.add(id);
    const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : null;
    out.push({
      addonServiceId: id,
      name: name ?? "",
      quantity: Number.isFinite(qty) && qty > 1 ? Math.floor(qty) : 1,
      done: !skipped.has(id),
    });
  }
  return out;
}

/** The marks the database accepts: a groom that is still to finish. */
export function groomAddonsMarkable(status: string | null | undefined): boolean {
  return status === "scheduled" || status === "in_progress";
}
