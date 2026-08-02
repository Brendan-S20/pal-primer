import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

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
  .inputValidator((d) => z.object({ organizationId: z.string().uuid().optional() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = data.organizationId ?? (await resolveOrgId(supabase, userId));
    // `seed_demo_org` calls `assign_demo_visits_to_staff` itself and then hands
    // today's route to the tech. The second call that used to be here re-ran
    // the round-robin over today and the future, undoing that — two
    // implementations of "who is this visit assigned to", with the loser
    // decided by call order.
    const { data: result, error } = await (supabase.rpc as any)("seed_demo_org", { _org_id: orgId });
    if (error) throw new Error(error.message);
    return result as unknown as { ok: boolean; clients: number; visits_created: number; invoices_created: number };
  });
