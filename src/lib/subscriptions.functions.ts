import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const createSubSchema = z
  .object({
    clientId: z.string().uuid(),
    propertyId: z.string().uuid(),
    accountType: z.enum(["residential", "commercial"]),
    frequency: z.enum(["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]),
    priceCents: z.number().int().min(0),
    dogCount: z.number().int().min(1).optional(),
    unitCount: z.number().int().min(1).optional(),
    zoneId: z.string().uuid().optional(),
    startedOn: z.string().optional(), // YYYY-MM-DD
  })
  .refine(
    (v) =>
      (v.accountType === "residential" && v.dogCount && !v.unitCount) ||
      (v.accountType === "commercial" && v.unitCount && !v.dogCount),
    { message: "residential requires dogCount; commercial requires unitCount" },
  );

export const createSubscription = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => createSubSchema.parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error: cErr } = await supabase
      .from("clients")
      .select("organization_id")
      .eq("id", data.clientId)
      .single();
    if (cErr) throw new Error(cErr.message);

    const { data: row, error } = await supabase
      .from("subscriptions")
      .insert({
        organization_id: client.organization_id,
        client_id: data.clientId,
        property_id: data.propertyId,
        account_type: data.accountType,
        frequency: data.frequency,
        price_cents: data.priceCents,
        dog_count: data.dogCount ?? null,
        unit_count: data.unitCount ?? null,
        zone_id: data.zoneId ?? null,
        started_on: data.startedOn ?? undefined,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

export const listSubscriptionsForClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ clientId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: rows, error } = await supabase
      .from("subscriptions")
      .select("id, account_type, frequency, price_cents, dog_count, unit_count, zone_id, status, started_on, property_id")
      .eq("client_id", data.clientId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return { subscriptions: rows ?? [] };
  });
