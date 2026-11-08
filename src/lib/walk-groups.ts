/** The same plan-first dog count used by public.walk_dogs_on_visit. */
export function dogsOnWalk(planDogs: number | null | undefined, activeDogs: number): number {
  return Math.max(planDogs ?? activeDogs, 1);
}

export type WalkGroupVisit = {
  id: string;
  serviceId: string | null;
  groupId: string | null;
  client: string;
  /** The client this visit is billed to. One visit, one client, one bill. */
  clientId: string | null;
  dogs: string[];
  dogCount: number;
  status: string;
  /** visits.assigned_staff_id: who holds this walk now. */
  walkerId: string | null;
  /** visits.route_pinned: kept with its walker by hand (#609, D10). */
  pinned: boolean;
  /** The visit's own price, or its plan's (what the billing run charges). */
  priceCents: number | null;
};

export type WalkGroupSummary = {
  id: string;
  serviceId: string;
  service: string;
  maxDogs: number;
  walkerId: string | null;
  earliestTime: string | null;
  latestTime: string | null;
  members: WalkGroupVisit[];
};

/** A person who could walk a group. `maxDogs` is staff.max_dogs_per_walk:
 *  null means the business set no cap for them (the default). */
export type WalkerCapacity = {
  id: string;
  name: string;
  maxDogs: number | null;
  /** staff_services: empty means any service. */
  services: string[];
};

// ── Who the Walker select should say (R2-29) ─────────────────────────────

export type GroupWalkerView =
  /** The group names its walker. */
  | { kind: "group"; walkerId: string }
  /** The group names nobody, but every walk still to happen in it is held by
   *  the same person: assigned on the board, by Optimize, or by hand before
   *  the walk joined. This is what R2-29 saw as "Unassigned". */
  | { kind: "members"; walkerId: string }
  /** The walks still to happen are held by different people. */
  | { kind: "mixed"; walkerIds: string[] }
  | { kind: "none" };

const holding = (status: string) => status === "scheduled" || status === "in_progress";

/** What the group's Walker select shows. The group row is the source of truth
 *  when it names someone; otherwise the members are, because they are what the
 *  walker's day, My Day and the route are built from. */
export function groupWalkerView(
  group: Pick<WalkGroupSummary, "walkerId" | "members">,
): GroupWalkerView {
  if (group.walkerId) return { kind: "group", walkerId: group.walkerId };
  const held = [
    ...new Set(
      group.members
        .filter((m) => holding(m.status))
        .map((m) => m.walkerId)
        .filter((id): id is string => Boolean(id)),
    ),
  ];
  const anyUnheld = group.members.some((m) => holding(m.status) && !m.walkerId);
  if (held.length === 1 && !anyUnheld) return { kind: "members", walkerId: held[0] };
  if (held.length >= 1) return { kind: "mixed", walkerIds: held.sort() };
  return { kind: "none" };
}

/** The options the Walker select lists: the people who run routes, plus
 *  whoever the group already shows, even when that person is not in the list
 *  (an owner who walks but is not ticked "Runs routes", someone deactivated).
 *  A controlled <select> whose value matches no option draws its first option,
 *  which is "Unassigned": the other half of R2-29. */
type Person = { id: string; display_name: string | null };

export function walkerOptions(
  walkers: Person[],
  everyone: Person[],
  shown: string | null,
): Array<{ id: string; label: string; outsideList: boolean }> {
  const out = walkers.map((w) => ({
    id: w.id,
    label: w.display_name ?? "Walker",
    outsideList: false,
  }));
  if (shown && !out.some((o) => o.id === shown)) {
    const person = everyone.find((p) => p.id === shown);
    out.push({
      id: shown,
      label: person?.display_name ?? "Another team member",
      outsideList: true,
    });
  }
  return out;
}

/** "" is no cap; anything else must be a whole number from 1 to 50. */
export function parseDogCap(raw: string): { ok: true; value: number | null } | { ok: false } {
  const t = raw.trim();
  if (t === "") return { ok: true, value: null };
  if (!/^\d+$/.test(t)) return { ok: false };
  const n = Number(t);
  return n >= 1 && n <= 50 ? { ok: true, value: n } : { ok: false };
}

/** Dogs in a group that still hold a place: scheduled or in progress, the
 *  same rule as validate_walk_group_member. */
export function dogsHoldingPlaces(members: Pick<WalkGroupVisit, "status" | "dogCount">[]): number {
  return members.filter((m) => holding(m.status)).reduce((sum, m) => sum + m.dogCount, 0);
}

/** How many dogs a group may hold with this walker: the service's group size,
 *  lowered to the walker's own cap when the business set one. */
export function groupCapacity(serviceMax: number, walkerMax: number | null | undefined): number {
  return walkerMax == null ? serviceMax : Math.min(serviceMax, walkerMax);
}

// ── Per-client billing on a shared walk ──────────────────────────────────

export type GroupBillingLine = {
  clientId: string | null;
  client: string;
  visitIds: string[];
  dogs: number;
  priceCents: number | null;
};

/** Who a shared walk bills, and for what. A group walk is not a bill: every
 *  member is that client's own visit, billed by the ordinary run once through
 *  invoice_line_items.visit_id (unique per visit). This only reads that back
 *  for the office, one line per client, so nothing here can bill anything. A
 *  canceled or skipped member left the group and is not listed. */
export function groupBilling(members: WalkGroupVisit[]): GroupBillingLine[] {
  const lines = new Map<string, GroupBillingLine>();
  const seen = new Set<string>();
  for (const m of members) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    if (m.status === "canceled" || m.status === "skipped") continue;
    const key = m.clientId ?? `visit:${m.id}`;
    const line = lines.get(key) ?? {
      clientId: m.clientId,
      client: m.client,
      visitIds: [],
      dogs: 0,
      priceCents: 0,
    };
    line.visitIds.push(m.id);
    line.dogs += m.dogCount;
    line.priceCents =
      line.priceCents == null || m.priceCents == null ? null : line.priceCents + m.priceCents;
    lines.set(key, line);
  }
  return [...lines.values()];
}

// ── Assign by capacity ───────────────────────────────────────────────────

export type CapacityDecision =
  | { groupId: string; action: "assign"; walkerId: string }
  | {
      groupId: string;
      action: "keep";
      reason: "has_walker" | "members_assigned" | "empty" | "no_walker_fits";
    };

/**
 * Pick a walker for each group that has none, by capacity.
 *
 * Never moves work someone already placed (#609, D10):
 *   * a group that names a walker is kept;
 *   * a group with any walk still to happen that is already held by someone,
 *     or pinned, is kept — assigning the group would copy its walker onto
 *     every member (copy_walk_group_walker) and undo that hand assignment.
 *
 * Among the walkers who can take the group (their cap, if any, fits the dogs;
 * their skills, if any, include the service), the one with the fewest dogs
 * already that day takes it, counting groups assigned earlier in this run;
 * ties go to the most room under the cap, then by name, so the same day gives
 * the same answer twice. Biggest groups are placed first, because they have
 * the fewest walkers who fit.
 *
 * `dayLoad` is dogs each walker already holds that day outside these groups.
 */
export function planWalkerCapacity(
  groups: WalkGroupSummary[],
  walkers: WalkerCapacity[],
  dayLoad: Record<string, number> = {},
): CapacityDecision[] {
  const load = new Map<string, number>(walkers.map((w) => [w.id, dayLoad[w.id] ?? 0]));
  for (const g of groups) {
    for (const m of g.members) {
      const who = holding(m.status) ? (m.walkerId ?? g.walkerId) : null;
      if (who && load.has(who)) load.set(who, (load.get(who) ?? 0) + m.dogCount);
    }
  }
  const decisions = new Map<string, CapacityDecision>();
  const open: Array<{ g: WalkGroupSummary; dogs: number }> = [];
  for (const g of groups) {
    const dogs = dogsHoldingPlaces(g.members);
    if (g.walkerId) decisions.set(g.id, { groupId: g.id, action: "keep", reason: "has_walker" });
    else if (g.members.some((m) => holding(m.status) && (m.walkerId || m.pinned)))
      decisions.set(g.id, { groupId: g.id, action: "keep", reason: "members_assigned" });
    else if (dogs === 0) decisions.set(g.id, { groupId: g.id, action: "keep", reason: "empty" });
    else open.push({ g, dogs });
  }
  open.sort((a, b) => b.dogs - a.dogs || a.g.id.localeCompare(b.g.id));
  for (const { g, dogs } of open) {
    const fits = walkers.filter(
      (w) =>
        (w.maxDogs == null || w.maxDogs >= dogs) &&
        (w.services.length === 0 || w.services.includes(g.serviceId)),
    );
    if (!fits.length) {
      decisions.set(g.id, { groupId: g.id, action: "keep", reason: "no_walker_fits" });
      continue;
    }
    const room = (w: WalkerCapacity) => (w.maxDogs == null ? Infinity : w.maxDogs - dogs);
    fits.sort(
      (a, b) =>
        (load.get(a.id) ?? 0) - (load.get(b.id) ?? 0) ||
        (room(a) === room(b) ? 0 : room(b) > room(a) ? 1 : -1) ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    );
    const pick = fits[0];
    load.set(pick.id, (load.get(pick.id) ?? 0) + dogs);
    decisions.set(g.id, { groupId: g.id, action: "assign", walkerId: pick.id });
  }
  return groups.map((g) => decisions.get(g.id)!);
}

/** The office's words for a group Assign by capacity left alone. */
export const CAPACITY_KEEP_REASON: Record<
  Extract<CapacityDecision, { action: "keep" }>["reason"],
  string
> = {
  has_walker: "already has a walker",
  members_assigned: "its walks are already assigned by hand",
  empty: "has no walks yet",
  no_walker_fits: "no walker's dog cap fits it",
};
