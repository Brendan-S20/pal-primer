import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// One row per custom email domain shared by 2+ organizations — the tell-tale
// that separate signups are really one multi-location operator (BUILD-6).
export type FranchiseSignalRow = {
  email_domain: string;
  org_count: number;
  org_names: string; // ' · '-separated, pre-joined by the SQL
  organization_ids: string[];
  states: string; // ', '-separated distinct properties.region values
  state_count: number;
  stripe_accounts: number;
  already_linked: number; // orgs with a parent_organization_id — the conversation already happened
};

async function assertPlatformAdmin(supabase: any, userId: string) {
  const { data, error } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (error) throw new Error(error.message);
  if (!data) throw new Error("Forbidden");
}

export const getFranchiseSignals = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ rows: FranchiseSignalRow[] }> => {
    await assertPlatformAdmin(context.supabase, context.userId);
    // Caller's client, not supabaseAdmin: franchise_signals() re-checks
    // is_platform_admin(auth.uid()) itself, so the SQL gate stays exercised.
    const { data, error } = await context.supabase.rpc("franchise_signals");
    if (error) throw new Error(error.message);
    return { rows: (data ?? []) as FranchiseSignalRow[] };
  });
