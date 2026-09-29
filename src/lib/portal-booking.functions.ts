// The owner's two answers about extra cleanups customers ask for from the
// portal: what one costs, and whether it is booked without waiting for the
// office. Read by Settings -> Client portal and by the office's "Book it"
// dialog on /concerns, which starts its price field from the first answer.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import { hasPermission } from "@/lib/permissions";

export type PortalBookingSettings = {
  /** organizations.portal_auto_accept_bookings. */
  autoAccept: boolean;
  /** organizations.one_off_price_cents; null = priced by the office each time. */
  priceCents: number | null;
  currency: string;
  canEdit: boolean;
};

export const getPortalBookingSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<PortalBookingSettings> => {
    const { orgId, role } = await resolveCaller(context.supabase, context.userId);
    const { data, error } = await (context.supabase.from("organizations") as any)
      .select("portal_auto_accept_bookings, one_off_price_cents, currency")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      autoAccept: !!data?.portal_auto_accept_bookings,
      priceCents: (data?.one_off_price_cents as number | null) ?? null,
      currency: ((data?.currency as string | null) ?? "usd").toLowerCase(),
      canEdit: hasPermission(role, "manage_settings"),
    };
  });

export const setPortalBookingSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        autoAccept: z.boolean(),
        // The same bounds as organizations_one_off_price_cents_check, so the
        // owner reads a sentence rather than a constraint name.
        priceCents: z.number().int().min(0).max(1_000_000).nullable(),
      })
      .refine((v) => !v.autoAccept || v.priceCents != null, {
        message: "Set a price first: a booking made without anyone looking needs one.",
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_settings");
    const { updateOwnOrg } = await import("@/lib/org-write.server");
    await updateOwnOrg(context.supabase, orgId, {
      portal_auto_accept_bookings: data.autoAccept,
      one_off_price_cents: data.priceCents,
    });
    return { ok: true, ...data };
  });
