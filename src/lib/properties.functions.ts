import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const createPropSchema = z.object({
  clientId: z.string().uuid(),
  label: z.string().max(120).optional(),
  street: z.string().min(1).max(200),
  city: z.string().min(1).max(120),
  region: z.string().max(120).optional(),
  postalCode: z.string().min(1).max(20),
  gateCode: z.string().max(60).optional(),
});

export const createProperty = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createPropSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    // Resolve org via client
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
      .select("id, label, street, city, region, postal_code, gate_code")
      .eq("client_id", data.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { properties: rows ?? [] };
  });
