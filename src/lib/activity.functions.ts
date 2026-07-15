import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const listClientActivity = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z
      .object({
        clientId: z.string().uuid(),
        limit: z.number().int().min(1).max(200).optional(),
        before: z.string().datetime({ offset: true }).optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    let q = context.supabase
      .from("activity_log")
      .select("id, kind, summary, meta, actor_label, actor_user_id, property_id, subscription_id, created_at")
      .eq("client_id", data.clientId)
      .order("created_at", { ascending: false })
      .limit(data.limit ?? 50);
    if (data.before) q = q.lt("created_at", data.before);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { entries: rows ?? [] };
  });
