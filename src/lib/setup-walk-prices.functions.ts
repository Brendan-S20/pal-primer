// /setup's walk prices (#769): the 30- and 60-minute walk, and the optional
// drop-in, priced without leaving setup.
//
// Its own function rather than updateService, because updateService writes
// the WHOLE service (name, unit, length, booking mode) and setup only knows a
// price. Sending the rest back from a form that never showed it would write
// whatever the browser last read over a change made in Settings meanwhile.
// This writes base_price_cents and nothing else.
//
// Gated like every other price write: manage_pricing (owner, office
// manager), and RLS asks the same question. Only this business's ACTIVE
// dog-walking services are touched, so a crafted id cannot reprice a
// pet-waste service, a stay or another business's walk.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { SERVICE_MAX_CENTS } from "@/lib/services";

export const setSetupWalkPrices = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        prices: z
          .array(
            z.object({
              id: z.string().uuid(),
              // null clears an optional walk's price (the drop-in left blank).
              cents: z.number().int().min(1).max(SERVICE_MAX_CENTS).nullable(),
            }),
          )
          .min(1)
          .max(20),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    for (const p of data.prices) {
      const { data: rows, error } = await context.supabase
        .from("services")
        .update({ base_price_cents: p.cents })
        .eq("id", p.id)
        .eq("organization_id", orgId)
        .eq("service_line", "dog_walking")
        .eq("active", true)
        .select("id");
      if (error) throw new Error(error.message);
      if (!rows || rows.length === 0) throw new Error("That walk was not found.");
    }
    return { ok: true };
  });
