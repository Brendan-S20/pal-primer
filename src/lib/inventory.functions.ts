import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

export const listStaff = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "manage_inventory");
    const { data, error } = await context.supabase
      .from("staff")
      .select("id, display_name")
      .eq("active", true)
      .order("display_name");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listItems = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "manage_inventory");
    const { data, error } = await context.supabase
      .from("inventory_items")
      .select("*")
      .order("name");
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listAssignments = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "manage_inventory");
    const { data, error } = await context.supabase
      .from("inventory_assignments")
      .select("id, item_id, staff_id, quantity, inventory_items(name, unit), staff(display_name)")
      .order("updated_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const listRecentMovements = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requirePermission(context.supabase, context.userId, "manage_inventory");
    const { data, error } = await context.supabase
      .from("inventory_movements")
      .select("id, kind, quantity, note, created_at, item_id, staff_id, inventory_items(name, unit), staff(display_name)")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw new Error(error.message);
    return data ?? [];
  });

export const upsertItem = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    id: z.string().uuid().optional(),
    name: z.string().min(1),
    sku: z.string().optional().nullable(),
    unit: z.string().default("each"),
    unit_cost_cents: z.number().int().min(0).default(0),
    reorder_threshold: z.number().min(0).default(0),
    category: z.string().optional().nullable(),
    active: z.boolean().default(true),
    notes: z.string().optional().nullable(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_inventory");
    const { supabase, userId } = context;
    const { data: staff } = await supabase
      .from("staff")
      .select("organization_id")
      .eq("user_id", userId)
      .limit(1)
      .single();
    if (!staff) throw new Error("No organization");
    const row = { ...data, organization_id: staff.organization_id };
    const { data: saved, error } = data.id
      ? await supabase.from("inventory_items").update(row).eq("id", data.id).select().single()
      : await supabase.from("inventory_items").insert(row).select().single();
    if (error) throw new Error(error.message);
    return saved;
  });

export const recordMovement = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({
    item_id: z.string().uuid(),
    kind: z.enum(["purchase", "assign", "unassign", "consume", "adjust"]),
    quantity: z.number(),
    staff_id: z.string().uuid().optional().nullable(),
    visit_id: z.string().uuid().optional().nullable(),
    note: z.string().optional().nullable(),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_inventory");
    const { supabase, userId } = context;
    const { data: item, error: iErr } = await supabase
      .from("inventory_items")
      .select("organization_id")
      .eq("id", data.item_id)
      .single();
    if (iErr || !item) throw new Error("Item not found");
    const { error } = await supabase.from("inventory_movements").insert({
      ...data,
      organization_id: item.organization_id,
      created_by: userId,
    });
    if (error) throw new Error(error.message);
    return { ok: true };
  });
