import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";

export const confirmStay = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        stayId: z.string().uuid(),
        depositCents: z.number().int().min(0).max(10_000_000).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { data: invoiceId, error } = await context.supabase.rpc("confirm_stay", {
      _stay_id: data.stayId,
      _deposit_cents: data.depositCents,
    });
    if (error) throw new Error(error.message);
    const { notifyStayConfirmed } = await import("@/lib/stay-notify.server");
    await notifyStayConfirmed(data.stayId);
    return { invoiceId };
  });

export const listRequestedStays = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await requirePermission(
      context.supabase,
      context.userId,
      "view_client_directory",
    );
    const { data, error } = await context.supabase
      .from("stays")
      .select(
        "id, client_id, starts_on, ends_on, kind, notes, pet_ids, drop_in_windows, overnight_arrival_earliest, overnight_arrival_latest, clients(display_name), services(name)",
      )
      .eq("organization_id", orgId)
      .eq("status", "requested")
      .order("starts_on");
    if (error) throw new Error(error.message);
    return { stays: data ?? [] };
  });
