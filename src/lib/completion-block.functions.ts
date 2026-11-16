import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Asked by every Complete button before it saves anything (#851 follow-up).
 *  Null when the visit is not held by the owner's BLOCK rule. */
export const getCompletionBlockWarning = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) => z.object({ visitId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    const { completionBlockWarning } = await import("@/lib/completion-block.server");
    return completionBlockWarning(context.supabase as any, data.visitId);
  });
