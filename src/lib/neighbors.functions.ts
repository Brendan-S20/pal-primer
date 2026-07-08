import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";

async function resolveOrgId(supabase: any, userId: string): Promise<string> {
  return (await resolveCaller(supabase, userId)).orgId;
}

export type NeighborLead = {
  id: string;
  seed_client_id: string | null;
  seed_client_name: string | null;
  address_line: string;
  latitude: number | null;
  longitude: number | null;
  status: "new" | "contacted" | "interested" | "converted" | "not_interested";
  notes: string | null;
  contacted_at: string | null;
  created_at: string;
};

export const listNeighborLeads = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId, role } = await resolveCaller(context.supabase, context.userId);
    const canSeeDirectory = hasPermission(role, "view_client_directory");
    const { data, error } = await context.supabase
      .from("neighbor_leads")
      .select("id, seed_client_id, address_line, latitude, longitude, status, notes, contacted_at, created_at, clients:seed_client_id(display_name)")
      .eq("organization_id", orgId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw new Error(error.message);
    const rows: NeighborLead[] = (data ?? []).map((r: any) => ({
      id: r.id,
      seed_client_id: canSeeDirectory ? r.seed_client_id : null,
      seed_client_name: canSeeDirectory ? (r.clients?.display_name ?? null) : null,
      address_line: r.address_line,
      latitude: r.latitude,
      longitude: r.longitude,
      status: r.status,
      notes: r.notes,
      contacted_at: r.contacted_at,
      created_at: r.created_at,
    }));
    const summary = rows.reduce(
      (acc, r) => {
        acc.total++;
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      },
      { total: 0 } as Record<string, number>,
    );
    return { rows, summary };
  });

const addSchema = z.object({
  addressLine: z.string().min(3).max(240),
  seedClientId: z.string().uuid().optional().nullable(),
  latitude: z.number().min(-90).max(90).optional().nullable(),
  longitude: z.number().min(-180).max(180).optional().nullable(),
  notes: z.string().max(1000).optional().nullable(),
});

export const addNeighborLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => addSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: row, error } = await context.supabase
      .from("neighbor_leads")
      .insert({
        organization_id: orgId,
        address_line: data.addressLine,
        seed_client_id: data.seedClientId || null,
        latitude: data.latitude ?? null,
        longitude: data.longitude ?? null,
        notes: data.notes || null,
        created_by: context.userId,
      })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    return { id: row.id as string };
  });

const seedSchema = z.object({
  clientId: z.string().uuid(),
  count: z.number().int().min(1).max(20).default(5),
});

/**
 * Seed neighbor leads for a client by generating placeholder addresses
 * within +/-5 house numbers of that client's property street. Marks each
 * new door as "canvass this street".
 */
export const seedNeighborsForClient = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => seedSchema.parse(d))
  .handler(async ({ data, context }) => {
    const orgId = await resolveOrgId(context.supabase, context.userId);
    const { data: prop } = await context.supabase
      .from("properties")
      .select("street, city, region, postal_code, latitude, longitude")
      .eq("client_id", data.clientId)
      .limit(1)
      .maybeSingle();
    if (!prop?.street) throw new Error("Client has no property with a street address");

    // Parse house number from start of street
    const m = /^(\d+)\s+(.*)$/.exec(prop.street.trim());
    if (!m) throw new Error("Could not parse street number");
    const base = Number(m[1]);
    const rest = m[2];

    const rows: any[] = [];
    // alternate offsets (even numbers on same side)
    for (let i = 1; rows.length < data.count && i <= 20; i++) {
      const offset = i * 2;
      for (const delta of [offset, -offset]) {
        const n = base + delta;
        if (n <= 0) continue;
        rows.push({
          organization_id: orgId,
          seed_client_id: data.clientId,
          address_line: `${n} ${rest}${prop.city ? `, ${prop.city}` : ""}${prop.region ? `, ${prop.region}` : ""}${prop.postal_code ? ` ${prop.postal_code}` : ""}`,
          latitude: prop.latitude,
          longitude: prop.longitude,
          created_by: context.userId,
        });
        if (rows.length >= data.count) break;
      }
    }
    if (rows.length === 0) return { added: 0 };
    const { error } = await context.supabase.from("neighbor_leads").insert(rows);
    if (error) throw new Error(error.message);
    return { added: rows.length };
  });

const updateSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(["new", "contacted", "interested", "converted", "not_interested"]).optional(),
  notes: z.string().max(1000).optional().nullable(),
});

export const updateNeighborLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => updateSchema.parse(d))
  .handler(async ({ data, context }) => {
    const patch: any = {};
    if (data.status) {
      patch.status = data.status;
      if (data.status === "contacted") patch.contacted_at = new Date().toISOString();
    }
    if (data.notes !== undefined) patch.notes = data.notes;
    const { error } = await context.supabase.from("neighbor_leads").update(patch).eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const deleteNeighborLead = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { error } = await context.supabase.from("neighbor_leads").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
