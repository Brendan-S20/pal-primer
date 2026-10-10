// A technician's service skills: Users & roles reads and writes them here.
//
// public.staff_services (20261010120000) holds one row per skill. No rows for
// a person means any service -- what every technician could do before skills
// existed, so a business that never opens this routes exactly as before.
// Rows mean exactly those services, and auto-routing gives a visit only to
// someone who can do it (route_day_inputs carries the list; the solver keeps
// to it).
//
// Gates, the same as the staff row's other routing facts (Runs routes,
// addresses, time off): any member reads, manage_users (the owner) writes.
// RLS asks the same question, so a client that skipped these functions would
// be refused by the database too.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

export type StaffServiceRow = { staff_id: string; service_id: string };

export const listStaffServices = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("staff_services")
      .select("staff_id, service_id")
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as StaffServiceRow[] };
  });

/** Replace one person's skills with exactly `serviceIds`. An empty list
 *  means any service. The delete and the inserts are two statements; a
 *  failed insert leaves the person with no rows, which is "any service"
 *  rather than a half-set, and the page refetches either way. */
export const setStaffServices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        staffId: z.string().uuid(),
        serviceIds: z.array(z.string().uuid()).max(200),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_users");
    const ids = [...new Set(data.serviceIds)];
    const { error: delError } = await context.supabase
      .from("staff_services")
      .delete()
      .eq("organization_id", orgId)
      .eq("staff_id", data.staffId);
    if (delError) throw new Error(delError.message);
    if (ids.length > 0) {
      const { error } = await context.supabase
        .from("staff_services")
        .insert(
          ids.map((service_id) => ({ organization_id: orgId, staff_id: data.staffId, service_id })),
        );
      // The same-business trigger and the FK answer in codes a person cannot
      // act on; say what they mean.
      if (error?.code === "23503") throw new Error("That service or person was not found.");
      if (error?.code === "42501") throw new Error("Not authorized");
      if (error) throw new Error(error.message);
    }
    return { ok: true, serviceIds: ids };
  });
