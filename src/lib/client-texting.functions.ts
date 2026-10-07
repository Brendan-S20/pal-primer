import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { resolveCaller } from "@/lib/authz.server";

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
 * show Coming soon, which is the truth for every business today.
 */
export const getClientTextingAvailability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { orgId } = await resolveCaller(context.supabase, context.userId);
    try {
      const { orgCanTextClients } = await import("@/lib/twilio-credentials.server");
      return { available: await orgCanTextClients(orgId) };
    } catch (e) {
      console.warn("texting availability lookup failed; showing Coming soon", e);
      return { available: false };
    }
  });
