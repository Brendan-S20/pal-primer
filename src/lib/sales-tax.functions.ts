import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission } from "@/lib/authz.server";
import { DEFAULT_SALES_TAX_LABEL, SALES_TAX_MAX_BPS } from "@/lib/sales-tax";

// The sales-tax settings on Settings > Invoicing. Their own pair of server
// functions rather than more keys on updateAutomationSettings: a tax rate is
// not automation, and the Automation page sends its whole payload on every
// save, so a key it never shows is a key it could one day clobber.
//
// manage_settings, the same gate as the rest of the Invoicing page. The
// database CHECKs (0..2500 bps, a 1-40 character label) are the backstop.

export const getSalesTaxSettings = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_settings");
    const { data, error } = await supabase
      .from("organizations")
      .select("sales_tax_rate_bps, sales_tax_label")
      .eq("id", orgId)
      .single();
    if (error) throw new Error(error.message);
    return {
      rateBps: Number(data?.sales_tax_rate_bps ?? 0),
      label: (data?.sales_tax_label as string | null) || DEFAULT_SALES_TAX_LABEL,
    };
  });

export const updateSalesTaxSettings = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        rateBps: z
          .number()
          .int()
          .min(0, "The tax rate can't be negative.")
          .max(SALES_TAX_MAX_BPS, "The tax rate can be at most 25%."),
        label: z
          .string()
          .trim()
          .min(1, "Give the tax line a name, such as Sales tax.")
          .max(40, "Keep the tax line's name to 40 characters."),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabase, userId } = context;
    const { orgId } = await requirePermission(supabase, userId, "manage_settings");
    const { data: before } = await supabase
      .from("organizations")
      .select("sales_tax_rate_bps, sales_tax_label")
      .eq("id", orgId)
      .single();
    const { error } = await supabase
      .from("organizations")
      .update({ sales_tax_rate_bps: data.rateBps, sales_tax_label: data.label })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    if (Number(before?.sales_tax_rate_bps ?? 0) !== data.rateBps) {
      // A rate change moves every invoice made from now on, so it is on the
      // record with who made it.
      const { logActivity } = await import("@/lib/activity.server");
      const { formatTaxRate } = await import("@/lib/sales-tax");
      await logActivity(supabase, {
        orgId,
        clientId: null,
        actorUserId: userId,
        kind: "settings.sales_tax_changed",
        summary: `Changed the sales tax rate from ${formatTaxRate(Number(before?.sales_tax_rate_bps ?? 0))} to ${formatTaxRate(data.rateBps)}`,
      });
    }
    return { ok: true };
  });
