import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** Which service lines are live, for a signed-in screen (Settings, /setup).
 *  The platform switch, read at runtime (#531); see
 *  service-line-availability.server.ts. */
export const getServiceLineAvailability = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { loadServiceLineAvailability } = await import("@/lib/service-line-availability.server");
    return loadServiceLineAvailability();
  });
