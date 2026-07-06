// Public plans catalog — read by /pricing so the public page always matches
// what /platform/plans shows. No auth required.
import { createServerFn } from "@tanstack/react-start";

export type PublicPlan = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  client_limit_min: number | null;
  client_limit_max: number | null;
  price_cents: number | null;
  price_per_client_cents: number | null;
  currency: string;
  is_free: boolean;
  sort_order: number | null;
};

export const listPublicPlans = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("platform_plans")
    .select(
      "id, name, slug, description, client_limit_min, client_limit_max, price_cents, price_per_client_cents, currency, is_free, sort_order",
    )
    .eq("is_active", true)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  // Collapse duplicate free-tier bands: keep only the first Free-marked plan
  // so the public grid doesn't render "Free" + "Puppy" as two identical cards.
  const seenFree = new Set<string>();
  const plans = ((data ?? []) as PublicPlan[]).filter((p) => {
    if (p.is_free) {
      if (seenFree.has("free")) return false;
      seenFree.add("free");
    }
    return true;
  });
  return { plans };
});
