import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listClientActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        /** Narrow to one service's own history — the service drawer asks this,
         *  so that a price change from two years ago is not lost behind fifty
         *  unrelated client edits. Still scoped by client_id underneath, so the
         *  RLS policy that governs this table is unchanged. */
        subscriptionId: z.string().uuid().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.string().datetime({ offset: true }).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("activity_log")
      .select(
        "id, kind, summary, meta, actor_label, actor_user_id, property_id, subscription_id, created_at",
      )
      .eq("client_id", data.clientId)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 50);
    if (data.subscriptionId) q = q.eq("subscription_id", data.subscriptionId);
    if (data.before) q = q.lt("created_at", data.before);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { entries: rows ?? [] };
  });
