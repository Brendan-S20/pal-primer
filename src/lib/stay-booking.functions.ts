import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { Database } from "@/integrations/supabase/types";
import { requirePermission } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";
import { readRequestedCare, type RequestedCareChange } from "@/lib/stays";

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
    // Booking, not pricing (#616): a dispatcher confirms a requested stay at
    // the service's price. A deposit is a price decision (confirm_stay
    // refuses it too, migration 20261109120000).
    const { role } = await requirePermission(context.supabase, context.userId, "booking");
    if (data.depositCents != null && !hasPermission(role, "manage_pricing"))
      throw new Error("Only an owner or office manager can ask for a deposit.");
    const { data: invoiceId, error } = await context.supabase.rpc("confirm_stay", {
      _stay_id: data.stayId,
      _deposit_cents: data.depositCents,
    });
    if (error) throw new Error(error.message);
    const { notifyStayConfirmed } = await import("@/lib/stay-notify.server");
    await notifyStayConfirmed(data.stayId);
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    return {
      invoiceId,
      gaps: await contactGaps(context.supabase, data.stayId),
      clash: await overnightClashWarning(context.supabase, { stayId: data.stayId }),
    };
  });

/** What the stay is missing for an emergency (stay_contact_gaps). A failed
 *  check is no warning rather than a failed confirm. */
async function contactGaps(supabase: any, stayId: string): Promise<string[]> {
  const { data, error } = await supabase.rpc("stay_contact_gaps", { _stay_id: stayId });
  if (error) {
    console.warn("stay contact check failed");
    return [];
  }
  return (data as string[] | null) ?? [];
}

/** Care changes the client sent with a still-requested stay (#611), with
 *  each pet's name. Confirming applies them to the sitter's card, so the
 *  office sees them first. RLS scopes the read to the caller's business. */
async function requestedCareChanges(
  supabase: SupabaseClient<Database>,
  stayId: string,
): Promise<Array<RequestedCareChange & { petName: string }>> {
  const { data: stay, error } = await supabase
    .from("stays")
    .select("status, pet_ids, requested_care")
    .eq("id", stayId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!stay || stay.status !== "requested") return [];
  const onStay = new Set<string>(stay.pet_ids ?? []);
  const changes = readRequestedCare(stay.requested_care).filter((c) => onStay.has(c.petId));
  if (changes.length === 0) return [];
  const { data: pets, error: petsError } = await supabase
    .from("dogs")
    .select("id, name")
    .in(
      "id",
      changes.map((c) => c.petId),
    );
  if (petsError) throw new Error(petsError.message);
  const names = new Map<string, string>((pets ?? []).map((p) => [p.id, p.name ?? ""]));
  return changes.map((c) => ({ ...c, petName: names.get(c.petId) || "Pet" }));
}

export const getStayContactGaps = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ stayId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requirePermission(context.supabase, context.userId, "view_client_directory");
    const { overnightClashWarning } = await import("@/lib/overnight-clashes.server");
    return {
      gaps: await contactGaps(context.supabase, data.stayId),
      clash: await overnightClashWarning(context.supabase, { stayId: data.stayId }),
      careChanges: await requestedCareChanges(context.supabase, data.stayId),
    };
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
