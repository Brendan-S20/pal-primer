import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// One row per custom email domain shared by 2+ organizations — the tell-tale
// that separate signups are really one multi-location operator (BUILD-6).
/** One organization in a cluster. Self-contained on purpose: this used to be a
 *  pre-joined `org_names` string beside an unordered `organization_ids` array,
 *  and the two were not in the same order — so zipping them to build per-org
 *  links, the obvious use, pointed at the wrong tenant about half the time.
 *  There is nothing left to zip. */
export type FranchiseSignalOrg = {
  id: string;
  name: string;
  /** Already has a parent — this one is a conversation that already happened. */
  linked: boolean;
};

export type FranchiseSignalRow = {
  email_domain: string;
  org_count: number;
  orgs: FranchiseSignalOrg[];
  states: string; // ', '-separated distinct properties.region values
  state_count: number;
  stripe_accounts: number;
  already_linked: number; // how many of `orgs` are linked — the count, kept for sorting
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

    // `orgs` arrives as jsonb, which the generated types can only describe as
    // `Json` — so a blind cast here would be the compiler agreeing to something
    // it cannot check, and one malformed row would crash the screen inside a
    // .map(). Narrowed instead, dropping anything that is not a usable pair.
    const isOrg = (o: unknown): o is FranchiseSignalOrg => {
      if (typeof o !== "object" || o === null) return false;
      const c = o as Record<string, unknown>;
      return typeof c.id === "string" && typeof c.name === "string";
    };

    const rows: FranchiseSignalRow[] = ((data ?? []) as Record<string, unknown>[]).map((r) => ({
      email_domain: String(r.email_domain ?? ""),
      org_count: Number(r.org_count ?? 0),
      orgs: (Array.isArray(r.orgs) ? r.orgs : []).filter(isOrg).map((o) => ({
        id: o.id,
        name: o.name,
        linked: o.linked === true,
      })),
      states: String(r.states ?? ""),
      state_count: Number(r.state_count ?? 0),
      stripe_accounts: Number(r.stripe_accounts ?? 0),
      already_linked: Number(r.already_linked ?? 0),
    }));
    return { rows };
  });
