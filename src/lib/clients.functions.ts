import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function resolveOrgId(supabase: ReturnType<typeof requireSupabaseAuth> extends never ? never : any, userId: string): Promise<string> {
  const { data, error } = await supabase
    .from("user_roles")
    .select("organization_id")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) throw new Error("No organization found for this user. Complete onboarding first.");
  return data.organization_id as string;
}

export const listClients = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data, error } = await supabase
      .from("clients")
      .select("id, display_name, account_type, primary_email, primary_phone, active, created_at")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return { clients: data ?? [] };
  });

const createClientSchema = z.object({
  displayName: z.string().min(1).max(200),
  accountType: z.enum(["residential", "commercial"]),
  primaryEmail: z.string().email().or(z.literal("")).optional(),
  primaryPhone: z.string().max(40).optional(),
});

export const createClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => createClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const orgId = await resolveOrgId(supabase, userId);
    const { data: row, error } = await supabase
      .from("clients")
      .insert({
        organization_id: orgId,
        display_name: data.displayName,
        account_type: data.accountType,
        primary_email: data.primaryEmail || null,
        primary_phone: data.primaryPhone || null,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

const getClientSchema = z.object({ clientId: z.string().uuid() });

export const getClient = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data) => getClientSchema.parse(data))
  .handler(async ({ data, context }) => {
    const { supabase } = context;
    const { data: client, error } = await supabase
      .from("clients")
      .select("id, display_name, account_type, primary_email, primary_phone, active, created_at, notes")
      .eq("id", data.clientId)
      .single();
    if (error) throw new Error(error.message);
    return { client };
  });
