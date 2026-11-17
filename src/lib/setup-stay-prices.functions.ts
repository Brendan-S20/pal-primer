// /setup's stay prices (#959): Drop-in, Overnight stay and House sit, priced
// without leaving setup. The walk version's twin (setup-walk-prices.functions,
// #769), for the same reason: updateService writes the WHOLE service, and
// setup only knows a price. This writes base_price_cents and nothing else.
//
// Gated like every other price write: manage_pricing (owner, office
// manager), and RLS asks the same question. Only this business's ACTIVE
// pet-sitting services are touched.
//
// All or nothing, checked before the first write: the part is done only when
// EVERY active stay has been saved (staysSavedForSetup), so a request that
// leaves one out, or prices one at nothing, is refused whole rather than
// written halfway and left open.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { SERVICE_MAX_CENTS } from "@/lib/services";
import { STAYS_MISSING, coversEveryStay } from "@/lib/setup-line-prices";

export const setSetupStayPrices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        prices: z
          .array(
            z.object({
              id: z.string().uuid(),
              cents: z.number().int().min(1).max(SERVICE_MAX_CENTS),
            }),
          )
          .min(1)
          .max(20),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { data: active, error: readError } = await context.supabase
      .from("services")
      .select("id")
      .eq("organization_id", orgId)
      .eq("service_line", "pet_sitting")
      .eq("active", true);
    if (readError) throw new Error(readError.message);
    const activeIds = (active ?? []).map((s) => s.id as string);
    if (
      !coversEveryStay(
        activeIds,
        data.prices.map((p) => p.id),
      )
    )
      throw new Error(STAYS_MISSING);
    for (const p of data.prices) {
      const { data: rows, error } = await context.supabase
        .from("services")
        .update({ base_price_cents: p.cents })
        .eq("id", p.id)
        .eq("organization_id", orgId)
        .eq("service_line", "pet_sitting")
        .eq("active", true)
        .select("id");
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) throw new Error("That stay was not found.");
    }
    return { ok: true };
  });
