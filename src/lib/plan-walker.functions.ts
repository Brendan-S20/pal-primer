// The walker on a walk plan (#731, audit F-17).
//
// A plan's walker is copied onto each NEW visit the plan makes that arrives
// with nobody on it (public.fill_visit_walker, 20261108150100). Setting or
// clearing it here never moves a visit that already exists: those stay with
// whoever has them, and the office moves them on Routes as before.
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";

export const getPlanWalker = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ subscriptionId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const [plan, people] = await Promise.all([
      context.supabase
        .from("subscriptions")
        .select("id, assigned_staff_id")
        .eq("id", data.subscriptionId)
        .eq("organization_id", orgId)
        .maybeSingle(),
      context.supabase
        .from("staff")
        .select("id, display_name, is_field_tech, active")
        .eq("organization_id", orgId)
        .order("display_name"),
    ]);
    if (plan.error) throw new Error(plan.error.message);
    if (people.error) throw new Error(people.error.message);
    if (!plan.data) throw new Error("That plan was not found.");
    return {
      walkerId: plan.data.assigned_staff_id,
      people: (people.data ?? []).map((p) => ({
        id: p.id,
        display_name: p.display_name,
        is_field_tech: Boolean(p.is_field_tech),
        active: p.active !== false,
      })),
    };
  });

/** Dispatch's permission: the same database predicate group walks and
 *  reassign_visit check. */
export const setPlanWalker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ subscriptionId: z.string().uuid(), walkerId: z.string().uuid().nullable() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    const { data: allowed, error: authError } = await context.supabase.rpc("can_write_org", {
      _user_id: context.userId,
      _org_id: orgId,
    });
    if (authError) throw new Error(authError.message);
    if (!allowed) throw new Error("Not authorized");
    if (data.walkerId) {
      const { data: person, error } = await context.supabase
        .from("staff")
        .select("id, display_name, is_field_tech, active")
        .eq("id", data.walkerId)
        .eq("organization_id", orgId)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!person || person.active === false)
        throw new Error("Choose a walker from this business.");
      if (!person.is_field_tech)
        throw new Error(
          `${person.display_name ?? "That person"} is not set up to run routes. Turn on "Runs routes" for them in Settings → Users & roles first.`,
        );
    }
    const { data: rows, error } = await context.supabase
      .from("subscriptions")
      .update({ assigned_staff_id: data.walkerId })
      .eq("id", data.subscriptionId)
      .eq("organization_id", orgId)
      .select("id");
    if (error) throw new Error(error.message);
    if (!rows?.length) throw new Error("That plan was not found.");
    return { ok: true };
  });
