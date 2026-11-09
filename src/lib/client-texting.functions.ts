import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";
import type { ManagedTextingState } from "@/lib/managed-texting";

/**
 * Can the caller's business text its own clients? The switch every texting
 * control in the app reads (see lib/client-texting.ts).
 *
 * A server function because the answer lives beside credentials the browser
 * must never see: `orgCanTextClients` reads the subaccount row with the
 * service role and returns only the yes or no. Any signed-in member of the
 * business may ask: it says nothing about any client, and a tech's screen
 * needs it as much as the owner's.
 *
 * A failure reads as "not available", never as an error: the controls then
 * say texting is not switched on yet, which a failed read cannot contradict.
 */
export const getClientTextingAvailability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ available: boolean; state: ManagedTextingState | undefined }> => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    try {
      // site-r2-05: the state as well as the yes or no, so a control that
      // cannot send says why (Under review, Setup needed, Add-on) rather than
      // "coming soon" about a thing that is on sale.
      const { managedTextingStateFor } = await import("@/lib/managed-texting.server");
      const state = await managedTextingStateFor(orgId);
      return { available: state === "active", state };
    } catch (e) {
      console.warn("texting availability lookup failed; showing not available", e);
      return { available: false, state: undefined };
    }
  });
