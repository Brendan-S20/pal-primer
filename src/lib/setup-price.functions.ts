// One answer to "what do I charge per visit" (#766).
//
// ── WHAT WAS WRONG ─────────────────────────────────────────────────────────
//
// Setup's service-area step asks for a price per visit and a price per extra
// dog, and wrote them to the new zone and nowhere else. Two other places in
// Settings ask the same question and were left blank:
//
//   - Settings > Business > Standard pricing reads
//     organizations.std_base_price_cents / std_per_dog_addl_cents;
//   - Settings > Services lists "Pet waste removal" with services.base_price_cents,
//     which signup seeds as NULL ("no price").
//
// At Detroit Doo Disposal the zone said $25 and Standard said $30: two answers,
// and the owner's reasonable conclusion was that setup had not saved.
//
// So the setup price also fills those two, ONLY where they are still empty.
// Nothing an owner has already typed in Settings is ever overwritten from here.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { PET_WASTE_SERVICE_NAME } from "@/lib/services";

const cents = z.number().int().min(0).max(1_000_000);

export const adoptSetupAreaPrice = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ basePriceCents: cents, perDogAddlCents: cents }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(supabase, userId, "manage_pricing");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the untyped supabase-js builder, as elsewhere in src/lib
    const db = supabase as any;

    // ── Standard pricing ──
    const { data: org, error: readError } = await db
      .from("organizations")
      .select("std_base_price_cents, std_per_dog_addl_cents")
      .eq("id", orgId)
      .single();
    if (readError) throw new Error(readError.message);
    const base: number | null = org?.std_base_price_cents ?? null;
    const dog: number | null = org?.std_per_dog_addl_cents ?? null;
    let standardSet = false;
    if (base === null || dog === null) {
      // The same SECURITY DEFINER write Settings > Business uses: it sets both
      // columns, so the one already chosen is passed back unchanged.
      const { error } = await db.rpc("update_org_standard_pricing", {
        _org_id: orgId,
        _std_base_price_cents: base ?? data.basePriceCents,
        _std_per_dog_addl_cents: dog ?? data.perDogAddlCents,
      });
      if (error) throw new Error(error.message);
      standardSet = true;
    }

    // ── The default pet-waste service, while it still has no price ──
    const { data: rows, error: svcError } = await db
      .from("services")
      .update({ base_price_cents: data.basePriceCents, extra_pet_cents: data.perDogAddlCents })
      .eq("organization_id", orgId)
      .eq("service_line", "pet_waste")
      .eq("name", PET_WASTE_SERVICE_NAME)
      .is("base_price_cents", null)
      .select("id");
    if (svcError) throw new Error(svcError.message);

    return { standardSet, servicePriced: Array.isArray(rows) && rows.length > 0 };
  });
