import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization for this user");
  return data.organization_id as string;
}

export const reseedDemoData = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  // organizationId is accepted for call-site compatibility and DELIBERATELY
  // ignored — see the handler.
  .inputValidator((d) => z.object({ organizationId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    // The org id may NOT come from the client unchecked. This handler had
    // `requireSupabaseAuth` and no permission check, and `seed_demo_org` MASS
    // DELETES the target org's clients, visits, invoices, line items, QC
    // tickets and visit photos. Its own guard admits any owner or
    // office_manager of the named org, so an office_manager of a live tenant
    // could wipe their own organization's data through a reseed button.
    //
    // Two conditions now, and both are needed: the caller must hold
    // manage_settings in the org they name, AND the org must actually be a demo
    // org. `seed_demo_org` never checked the second — nothing about it is
    // limited to demo data except its name.
    // requirePermission resolves the caller's OWN org — which is the right
    // answer here. A client-supplied organizationId is exactly what made this
    // reachable across tenants, so it is now ignored rather than trusted.
    const { orgId } = await requirePermission(supabase, userId, "manage_settings");
    const { data: target } = await supabase
      .from("organizations")
      .select("slug, is_comped")
      .eq("id", orgId)
      .maybeSingle();
    if (!target?.is_comped && target?.slug !== "demo") {
      throw new Error(
        "Reseeding replaces every client, visit and invoice in the organization. " +
          "It is only available on demo accounts.",
      );
    }
    // `seed_demo_org` calls `assign_demo_visits_to_staff` itself and then hands
    // today's route to the tech. The second call that used to be here re-ran
    // the round-robin over today and the future, undoing that — two
    // implementations of "who is this visit assigned to", with the loser
    // decided by call order.
    const { data: result, error } = await (supabase.rpc as any)("seed_demo_org", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return result as unknown as { ok: boolean; clients: number; visits_created: number; invoices_created: number };
  });
