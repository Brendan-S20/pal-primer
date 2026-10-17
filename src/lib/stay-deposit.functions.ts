// How many days before a stay its deposit stays refundable
// (organizations.stay_deposit_refund_days, migration 20261017050000).
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
    const { data, error } = await context.supabase
      .from("organizations")
      .select("stay_deposit_refund_days")
      .eq("id", orgId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return { refundDays: data?.stay_deposit_refund_days ?? DEFAULT_DEPOSIT_REFUND_DAYS };
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
