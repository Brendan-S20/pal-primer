import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import {
  dogsOnWalk,
  planWalkerCapacity,
  type WalkerCapacity,
  type WalkGroupVisit,
  type WalkGroupSummary,
} from "@/lib/walk-groups";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dogCapWarningFromError,
  withDogCapAck,
  type DogCapRefused,
  type OverCapWalk,
} from "@/lib/dog-cap";
import type { Database } from "@/integrations/supabase/types";

const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
  .nullable();

/** reassign_visit checks this same database predicate. */
async function requireWalkGroupOffice(supabase: SupabaseClient<Database>, userId: string) {
  const { orgId } = await resolveCaller(supabase, userId);
  const { data, error } = await supabase.rpc("can_write_org", { _user_id: userId, _org_id: orgId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Not authorized");
  return orgId;
}

/** Everyone a group could show as its walker, with their dog cap. Not only
 *  the people who run routes: a group can already be held by someone who is
 *  not (an owner who walks, a person since unticked), and the Walker select
 *  has to be able to say who (R2-29). */
export type WalkGroupStaff = {
  id: string;
  display_name: string | null;
  is_field_tech: boolean;
  active: boolean;
  routingAvailable: boolean;
  maxDogs: number | null;
};

/** The day's groups, the walks that could join them, and who could walk
 *  them. Shared by the list and Assign by capacity, so both read one day the
 *  same way. */
async function readWalkGroupDay(supabase: SupabaseClient<Database>, orgId: string, day: string) {
  const [groups, visits, people] = await Promise.all([
    supabase
      .from("walk_groups")
      .select(
        "id, service_id, assigned_staff_id, earliest_time, latest_time, services(name, max_dogs)",
      )
      .eq("organization_id", orgId)
      .eq("scheduled_on", day)
      .order("created_at"),
    supabase
      .from("visits")
      .select(
        "id, client_id, property_id, service_id, walk_group_id, status, assigned_staff_id, route_pinned, price_cents, subscriptions(dog_count, price_cents), clients(display_name), services(service_line)",
      )
      .eq("organization_id", orgId)
      .eq("scheduled_on", day)
      .or("status.in.(scheduled,in_progress),walk_group_id.not.is.null"),
    supabase
      .from("staff")
      .select("id, display_name, is_field_tech, active, routing_available, max_dogs_per_walk")
      .eq("organization_id", orgId)
      .order("display_name"),
  ]);
  if (groups.error) throw new Error(groups.error.message);
  if (visits.error) throw new Error(visits.error.message);
  if (people.error) throw new Error(people.error.message);
  const walks = (visits.data ?? []).filter(
    (visit) => visit.services?.service_line === "dog_walking",
  );
  const propertyIds = [...new Set(walks.map((visit) => visit.property_id))];
  const dogs = propertyIds.length
    ? await supabase
        .from("dogs")
        .select("property_id, name")
        .eq("organization_id", orgId)
        .eq("active", true)
        .eq("species", "dog")
        .in("property_id", propertyIds)
    : { data: [], error: null };
  if (dogs.error) throw new Error(dogs.error.message);
  const mapped: WalkGroupVisit[] = walks.map((visit) => {
    const names = (dogs.data ?? [])
      .filter((dog) => dog.property_id === visit.property_id)
      .map((dog) => dog.name);
    return {
      id: visit.id,
      serviceId: visit.service_id,
      groupId: visit.walk_group_id,
      client: visit.clients?.display_name ?? "Client",
      clientId: visit.client_id,
      dogs: names,
      dogCount: dogsOnWalk(visit.subscriptions?.dog_count, names.length),
      status: visit.status,
      walkerId: visit.assigned_staff_id,
      pinned: Boolean(visit.route_pinned),
      priceCents: visit.price_cents ?? visit.subscriptions?.price_cents ?? null,
    };
  });
  const summaries: WalkGroupSummary[] = (groups.data ?? []).map((group) => ({
    id: group.id,
    serviceId: group.service_id,
    service: group.services?.name ?? "Group walk",
    maxDogs: group.services?.max_dogs ?? 1,
    walkerId: group.assigned_staff_id,
    earliestTime: group.earliest_time,
    latestTime: group.latest_time,
    members: mapped.filter((visit) => visit.groupId === group.id),
  }));
  const staff: WalkGroupStaff[] = (people.data ?? []).map((p) => ({
    id: p.id,
    display_name: p.display_name,
    is_field_tech: Boolean(p.is_field_tech),
    active: p.active !== false,
    routingAvailable: p.routing_available !== false,
    maxDogs: p.max_dogs_per_walk ?? null,
  }));
  return { summaries, mapped, staff };
}

export const listWalkGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: daySchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { summaries, mapped, staff } = await readWalkGroupDay(context.supabase, orgId, data.day);
    return {
      groups: summaries,
      available: mapped.filter((visit) => visit.status === "scheduled" && !visit.groupId),
      staff,
    };
  });

export const walkGroupDraftSchema = z
  .object({
    serviceId: z.string().uuid(),
    day: daySchema,
    walkerId: z.string().uuid().nullable(),
    earliestTime: timeSchema,
    latestTime: timeSchema,
  })
  .refine((d) => !d.earliestTime || !d.latestTime || d.earliestTime < d.latestTime, {
    message: "The earliest arrival must be before the latest arrival.",
  });

export const createWalkGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => walkGroupDraftSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await requireWalkGroupOffice(context.supabase, context.userId);
    const { data: row, error } = await context.supabase
      .from("walk_groups")
      .insert({
        organization_id: orgId,
        service_id: data.serviceId,
        scheduled_on: data.day,
        assigned_staff_id: data.walkerId,
        earliest_time: data.earliestTime,
        latest_time: data.latestTime,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id };
  });

export const setWalkGroupMember = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        groupId: z.string().uuid().nullable(),
        // "Assign anyway" after the dog cap warning (src/lib/dog-cap.ts).
        overCapAcknowledged: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true } | DogCapRefused> => {
    const orgId = await requireWalkGroupOffice(context.supabase, context.userId);
    const { data: rows, error } = await withDogCapAck(
      context.supabase
        .from("visits")
        .update({ walk_group_id: data.groupId, sequence: null })
        .eq("id", data.visitId)
        .eq("organization_id", orgId)
        .eq("status", "scheduled")
        .select("id"),
      data.overCapAcknowledged,
    );
    // Over the walker's dog cap and not confirmed: nothing was saved; the
    // panel shows the warning and asks.
    const overCap = dogCapWarningFromError(error);
    if (overCap) return { overCap };
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("That scheduled walk was not found. Refresh the day.");
    return { ok: true };
  });

export const setWalkGroupWalker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        groupId: z.string().uuid(),
        walkerId: z.string().uuid().nullable(),
        overCapAcknowledged: z.boolean().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }): Promise<{ ok: true } | DogCapRefused> => {
    const orgId = await requireWalkGroupOffice(context.supabase, context.userId);
    const { data: rows, error } = await withDogCapAck(
      context.supabase
        .from("walk_groups")
        .update({ assigned_staff_id: data.walkerId })
        .eq("id", data.groupId)
        .eq("organization_id", orgId)
        .select("id"),
      data.overCapAcknowledged,
    );
    const overCap = dogCapWarningFromError(error);
    if (overCap) return { overCap };
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("That group walk was not found.");
    return { ok: true };
  });

export const deleteWalkGroup = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ groupId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await requireWalkGroupOffice(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase
      .from("walk_groups")
      .delete()
      .eq("id", data.groupId)
      .eq("organization_id", orgId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("That group walk was not found.");
    return { ok: true };
  });

/**
 * Which of THIS org's staff are off on `day`.
 *
 * public.is_staff_off is service-role only: 20260810140000 revoked it from
 * authenticated, because it takes any staff id and answers about anyone's
 * time off with no tenant check. Asked through the signed-in client, Assign
 * by capacity failed on production with "permission denied for function
 * is_staff_off" (#733 follow-up; caught by the live-migrations job's
 * check-rpc-grants).
 *
 * So it is asked as the service role, and that is only safe because of what
 * comes before and here:
 *   - the caller has already passed can_write_org for `orgId`
 *     (requireWalkGroupOffice, the first line of the handler);
 *   - every id is confirmed, again on the service role, to be a staff row of
 *     `orgId` before any is asked about. An id from anywhere else refuses the
 *     whole call rather than being skipped, so nothing about another
 *     business's people is ever looked up.
 * No GRANT changes: the function stays out of authenticated's reach.
 */
async function staffOffOn(orgId: string, staffIds: string[], day: string): Promise<Set<string>> {
  if (staffIds.length === 0) return new Set();
  const { supabaseAdmin: admin } = await import("@/integrations/supabase/client.server");
  const { data: mine, error: staffError } = await admin
    .from("staff")
    .select("id")
    .eq("organization_id", orgId)
    .in("id", staffIds);
  if (staffError) throw new Error(staffError.message);
  const ours = new Set((mine ?? []).map((row) => row.id));
  if (staffIds.some((id) => !ours.has(id)))
    throw new Error("A walker for this day is not in your business.");
  const off = await Promise.all(
    staffIds.map(async (id) => {
      const { data: isOff, error } = await admin.rpc("is_staff_off", { _staff_id: id, _day: day });
      if (error) throw new Error(error.message);
      return isOff ? id : null;
    }),
  );
  return new Set(off.filter((id): id is string => Boolean(id)));
}

/**
 * Assign by capacity (#731): give each group that has no walker to the walker
 * with room for its dogs and the lightest day. planWalkerCapacity decides;
 * this reads the day and writes only what it decided.
 *
 * It never takes work from anyone (#609, D10). A group that names a walker,
 * or whose walks are already held or pinned, is left as it is; and because
 * the day can change between this read and the write, the write is
 * public.assign_walk_group_if_open, which checks both again under row locks
 * and writes nothing if either changed. The database still checks each
 * walker's cap (walk_groups_walker_cap) and availability on the visits.
 */
export const assignWalkGroupsByCapacity = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: daySchema }).parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await requireWalkGroupOffice(context.supabase, context.userId);
    const { summaries, mapped, staff } = await readWalkGroupDay(context.supabase, orgId, data.day);
    // routable_staff's rule, read here because that function is service-role
    // only: active, runs routes, available, not off that day.
    const routable = staff.filter((p) => p.active && p.is_field_tech && p.routingAvailable);
    const skills = routable.length
      ? await context.supabase
          .from("staff_services")
          .select("staff_id, service_id")
          .eq("organization_id", orgId)
          .in(
            "staff_id",
            routable.map((p) => p.id),
          )
      : { data: [], error: null };
    if (skills.error) throw new Error(skills.error.message);
    const offIds = await staffOffOn(
      orgId,
      routable.map((p) => p.id),
      data.day,
    );
    const walkers: WalkerCapacity[] = routable
      .filter((p) => !offIds.has(p.id))
      .map((p) => ({
        id: p.id,
        name: p.display_name ?? "",
        maxDogs: p.maxDogs,
        services: (skills.data ?? []).filter((r) => r.staff_id === p.id).map((r) => r.service_id),
      }));
    // Dogs each walker already holds that day on solo walks.
    const dayLoad: Record<string, number> = {};
    for (const v of mapped)
      if (!v.groupId && v.walkerId && (v.status === "scheduled" || v.status === "in_progress"))
        dayLoad[v.walkerId] = (dayLoad[v.walkerId] ?? 0) + v.dogCount;
    const decisions = planWalkerCapacity(summaries, walkers, dayLoad);
    const assigned: Array<{ groupId: string; walkerId: string }> = [];
    const kept: Array<{ groupId: string; reason: string }> = [];
    for (const d of decisions) {
      if (d.action === "keep") {
        kept.push({ groupId: d.groupId, reason: d.reason });
        continue;
      }
      // One atomic step in the database (20261108170200): it locks the group
      // and every walk in it, re-reads them, and writes only if the group
      // still has no walker and no walk still to happen is held or pinned.
      // A hand assignment made since the read above is never replaced.
      const { data: outcome, error } = await context.supabase.rpc("assign_walk_group_if_open", {
        _group_id: d.groupId,
        _walker_id: d.walkerId,
      });
      if (error) throw new Error(error.message);
      if (outcome === "assigned") assigned.push({ groupId: d.groupId, walkerId: d.walkerId });
      else kept.push({ groupId: d.groupId, reason: outcome ?? "has_walker" });
    }
    return { assigned, kept };
  });

/** A walker's dog cap, on Users & roles. Same permission as the routing
 *  tickboxes beside it (setStaffRouting). null takes the cap away. */
export const setWalkerDogCap = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        maxDogs: z.number().int().min(1).max(50).nullable(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const { data: rows, error } = await context.supabase
      .from("staff")
      .update({ max_dogs_per_walk: data.maxDogs })
      .eq("id", data.staffId)
      .eq("organization_id", orgId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("That team member was not found.");
    return { ok: true };
  });

/** Every team member's dog cap, for Users & roles. */
export const listWalkerDogCaps = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("staff")
      .select("id, max_dogs_per_walk")
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []).map((r) => ({ id: r.id, maxDogs: r.max_dogs_per_walk })) };
  });

/** Walks over their walker's dog cap on `day` (#731, "warn but allow"): the
 *  board and My Day flag them until they are back under. The office gets the
 *  whole business; a walker gets only their own (walks_over_dog_cap). */
export const listWalksOverDogCap = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: daySchema }).parse(d))
  .handler(async ({ data, context }): Promise<{ walks: OverCapWalk[] }> => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase.rpc("walks_over_dog_cap", {
      _org: orgId,
      _day: data.day,
    });
    if (error) throw new Error(error.message);
    return {
      walks: (rows ?? []).map((r) => ({
        walkGroupId: r.walk_group_id,
        staffId: r.staff_id,
        visitIds: r.visit_ids ?? [],
        dogs: r.dogs,
        cap: r.cap,
      })),
    };
  });
