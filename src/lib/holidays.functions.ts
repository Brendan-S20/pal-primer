// Holiday dates (migration 20261024080800): a sitting visit on one of these
// dates takes its service's holiday surcharge. Not a closure; blackouts are
// closures. Setting one sets a price, so it needs manage_pricing as the
// surcharge itself does.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";

export const listHolidays = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { data, error } = await context.supabase
      .from("holiday_dates")
      .select("id, holiday_on, name")
      .eq("organization_id", orgId)
      .order("holiday_on");
    if (error) throw new Error(error.message);
    return { holidays: data ?? [] };
  });

export const addHoliday = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        holidayOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a date."),
        name: z.string().max(200).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { error } = await context.supabase.from("holiday_dates").insert({
      organization_id: orgId,
      holiday_on: data.holidayOn,
      name: data.name?.trim() || null,
    });
    if (error?.code === "23505") throw new Error("That date is already a holiday.");
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteHoliday = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { error } = await context.supabase
      .from("holiday_dates")
      .delete()
      .eq("id", data.id)
      .eq("organization_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
