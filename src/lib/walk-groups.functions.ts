import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { dogsOnWalk, type WalkGroupVisit, type WalkGroupSummary } from "@/lib/walk-groups";
import type { SupabaseClient } from "@supabase/supabase-js";
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

export const listWalkGroups = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ day: daySchema }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const [groups, visits] = await Promise.all([
      context.supabase
        .from("walk_groups")
        .select(
          "id, service_id, assigned_staff_id, earliest_time, latest_time, services(name, max_dogs)",
        )
        .eq("organization_id", orgId)
        .eq("scheduled_on", data.day)
        .order("created_at"),
      context.supabase
        .from("visits")
        .select(
          "id, property_id, service_id, walk_group_id, status, subscriptions(dog_count), clients(display_name), services(service_line)",
        )
        .eq("organization_id", orgId)
        .eq("scheduled_on", data.day)
        .or("status.eq.scheduled,walk_group_id.not.is.null"),
    ]);
    if (groups.error) throw new Error(groups.error.message);
    if (visits.error) throw new Error(visits.error.message);
    const walks = (visits.data ?? []).filter(
      (visit) => visit.services?.service_line === "dog_walking",
    );
    const propertyIds = [...new Set(walks.map((visit) => visit.property_id))];
    const dogs = propertyIds.length
      ? await context.supabase
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
        dogs: names,
        dogCount: dogsOnWalk(visit.subscriptions?.dog_count, names.length),
        status: visit.status,
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
    return {
      groups: summaries,
      available: mapped.filter((visit) => visit.status === "scheduled" && !visit.groupId),
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
    z.object({ visitId: z.string().uuid(), groupId: z.string().uuid().nullable() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await requireWalkGroupOffice(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase
      .from("visits")
      .update({ walk_group_id: data.groupId, sequence: null })
      .eq("id", data.visitId)
      .eq("organization_id", orgId)
      .eq("status", "scheduled")
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("That scheduled walk was not found. Refresh the day.");
    return { ok: true };
  });

export const setWalkGroupWalker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ groupId: z.string().uuid(), walkerId: z.string().uuid().nullable() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const orgId = await requireWalkGroupOffice(context.supabase, context.userId);
    const { data: rows, error } = await context.supabase
      .from("walk_groups")
      .update({ assigned_staff_id: data.walkerId })
      .eq("id", data.groupId)
      .eq("organization_id", orgId)
      .select("id");
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
