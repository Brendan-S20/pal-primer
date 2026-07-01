import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const yardSize = z.enum(["small", "medium", "large", "xlarge"]).optional();

const createPropSchema = z.object({
  clientId: z.string().uuid(),
  label: z.string().max(120).optional(),
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(20),
  gateCode: z.string().max(60).optional(),
  yardSize,
  invisibleFence: z.boolean().optional(),
  escapeRisk: z.boolean().optional(),
  dogInYardDuringService: z.boolean().optional(),
  aggressiveDog: z.boolean().optional(),
  beesWasps: z.boolean().optional(),
  sharpObjects: z.boolean().optional(),
  slipperySurfaces: z.boolean().optional(),
  doNotEnterIfDogOut: z.boolean().optional(),
  hazardNotes: z.string().max(1000).optional(),
});

export const createProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createPropSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    const { data: row, error } = await supabase
      .from("properties")
      .insert({
        client_id: data.clientId,
        organization_id: client.organization_id,
        label: data.label || null,
        street: data.street,
        city: data.city,
        region: data.region || null,
        postal_code: data.postalCode,
        gate_code: data.gateCode || null,
        yard_size: data.yardSize ?? null,
        invisible_fence: !!data.invisibleFence,
        escape_risk: !!data.escapeRisk,
        dog_in_yard_during_service: !!data.dogInYardDuringService,
        aggressive_dog: !!data.aggressiveDog,
        bees_wasps: !!data.beesWasps,
        sharp_objects: !!data.sharpObjects,
        slippery_surfaces: !!data.slipperySurfaces,
        do_not_enter_if_dog_out: !!data.doNotEnterIfDogOut,
        hazard_notes: data.hazardNotes || null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

export const listPropertiesForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("properties")
      .select(
        "id, label, street, city, region, postal_code, gate_code, yard_size, invisible_fence, escape_risk, dog_in_yard_during_service, aggressive_dog, bees_wasps, sharp_objects, slippery_surfaces, do_not_enter_if_dog_out, hazard_notes",
      )
      .eq("client_id", data.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { properties: rows ?? [] };
  });
