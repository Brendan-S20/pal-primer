// How many days before a stay its deposit stays refundable
// (organizations.stay_deposit_refund_days, migration 20261024080900).
// Canceling later keeps the deposit as a cancellation fee. It is a price
// rule, so it needs manage_pricing as the services on the same page do.

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { requirePermission, resolveCaller } from "@/lib/authz.server";
import { DEFAULT_DEPOSIT_REFUND_DAYS } from "@/lib/stays";

export const getStayDepositRule = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    // stay_summary_catch_up is newer than the generated types (20261109170000).
    const { data, error } = await (context.supabase as any)
      .from("organizations")
      .select("stay_deposit_refund_days, stay_summary_catch_up")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return {
      refundDays: (data?.stay_deposit_refund_days as number | null) ?? DEFAULT_DEPOSIT_REFUND_DAYS,
      summaryCatchUp: data?.stay_summary_catch_up === true,
    };
  });

export const setStayDepositRule = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        refundDays: z
          .number({ message: "Enter a number of days from 0 to 365." })
          .int("Enter a whole number of days.")
          .min(0, "Enter a number of days from 0 to 365.")
          .max(365, "Enter a number of days from 0 to 365."),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { orgId } = await requirePermission(context.supabase, context.userId, "manage_pricing");
    const { error } = await context.supabase
      .from("organizations")
      .update({ stay_deposit_refund_days: data.refundDays })
      .eq("id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

/** Who may change the stay summary catch-up: an owner or an office manager,
 *  as set_stay_summary_catch_up itself checks (migration 20261109170000). */
export const STAY_SUMMARY_CATCH_UP_ROLES = ["owner", "office_manager"] as const;

export function canSetStaySummaryCatchUp(role: string | null | undefined): boolean {
  return (STAY_SUMMARY_CATCH_UP_ROLES as readonly string[]).includes(role ?? "");
}

/** Whether the nightly catch sends summaries for stays that ended before it
 *  went live for this business (#747). An owner or office manager; the
 *  database refuses anyone else as well, so this check is the early answer,
 *  not the only one. */
export const setStaySummaryCatchUp = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ on: z.boolean() }).parse(d))
  .handler(async ({ data, context }) => {
    const { orgId, role } = await resolveCaller(context.supabase, context.userId);
    if (!canSetStaySummaryCatchUp(role)) throw new Error("Not authorized");
    const { error } = await (context.supabase as any).rpc("set_stay_summary_catch_up", {
      _org_id: orgId,
      _on: data.on,
    });
    if (error) throw new Error(error.message);
    return { on: data.on };
  });
