import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** After a bulk cancel from the office (the client page's Visits tab calls
 *  cancelVisitFromOffice once per visit with notifyClient: false): one email
 *  per client for the whole set, for the dog walks among them (#410). Same
 *  permission as the cancel itself, and only the caller's own business's
 *  visits are read. Never fails the action: the visits are already canceled. */
export const notifyCanceledWalks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d) =>
    z.object({ visitIds: z.array(z.string().uuid()).min(1).max(500) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    const { requirePermission } = await import("@/lib/authz.server");
    const caller = await requirePermission(
      context.supabase,
      context.userId,
      "manage_client_billing",
    );
    const { notifyWalksCanceled } = await import("@/lib/walk-notify.server");
    await notifyWalksCanceled({ visitIds: data.visitIds, orgId: caller.orgId });
    return { ok: true };
  });
