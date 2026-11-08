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

/**
 * Dispatch's permission (can_write_org: owner, office manager, dispatcher),
 * through public.set_plan_walker (20261108150200). The signed-in client
 * cannot UPDATE subscriptions as a dispatcher, because that policy guards a
 * plan's price and asks for manage_pricing; the function takes only the plan
 * and the walker and writes only the walker, so it opens nothing else. It
 * checks the walker is an active person in the plan's business who runs
 * routes, and refuses a plan in another business as "Not authorized".
 */
export const setPlanWalker = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({ subscriptionId: z.string().uuid(), walkerId: z.string().uuid().nullable() })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await resolveCaller(context.supabase, context.userId);
    const { error } = await context.supabase.rpc("set_plan_walker", {
      _subscription_id: data.subscriptionId,
      _walker_id: data.walkerId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
