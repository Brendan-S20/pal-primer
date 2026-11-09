// The groom card's add-ons and van hookups (#412), for the groomer on My Day
// and the office.
//
// The visit is read with the caller's own client, so RLS decides whether they
// may see it at all. Only then is the plan's add-on list read with the service
// role, scoped to that visit's own plan and organization: a groomer reads the
// names of the add-ons booked on their groom, not the plan's prices.
//
// A mark is written by set_groom_addon_done (20261109120000), which checks the
// caller is the visit's groomer or the office, that the add-on is on this
// groom, and that the groom is not finished.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  groomAddonsMarkable,
  groomAddonsOnVisit,
  type GroomVisitExtras,
} from "@/lib/groom-visit-extras";

const one = <T>(v: T | T[] | null | undefined): T | null =>
  Array.isArray(v) ? (v[0] ?? null) : (v ?? null);

export const getGroomVisitExtras = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }): Promise<GroomVisitExtras | null> => {
    const { data: visit, error } = await context.supabase
      .from("visits")
      .select(
        "id, organization_id, status, subscription_id, groom_addons_not_done, services(service_line), properties(van_power_available, van_water_available)",
      )
      .eq("id", data.visitId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!visit) return null;
    const service = one(visit.services as { service_line: string | null } | null);
    if (service?.service_line !== "mobile_grooming") return null;

    let planAddons: unknown = [];
    if (visit.subscription_id) {
      const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
      const { data: sub, error: subErr } = await supabaseAdmin
        .from("subscriptions")
        .select("groom_addons")
        .eq("id", visit.subscription_id)
        .eq("organization_id", visit.organization_id)
        .maybeSingle();
      if (subErr) throw new Error(subErr.message);
      planAddons = sub?.groom_addons ?? [];
    }

    const property = one(
      visit.properties as {
        van_power_available: boolean | null;
        van_water_available: boolean | null;
      } | null,
    );
    return {
      visitId: visit.id,
      canMark: groomAddonsMarkable(visit.status),
      addons: groomAddonsOnVisit(planAddons, visit.groom_addons_not_done),
      van: {
        power: property?.van_power_available === true,
        water: property?.van_water_available === true,
      },
    };
  });

export const setGroomAddonDone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        visitId: z.string().uuid(),
        addonServiceId: z.string().uuid(),
        done: z.boolean(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { data: notDone, error } = await context.supabase.rpc("set_groom_addon_done", {
      _visit_id: data.visitId,
      _addon_service_id: data.addonServiceId,
      _done: data.done,
    });
    if (error) throw new Error(error.message);
    return { notDone: (notDone ?? []) as string[] };
  });
