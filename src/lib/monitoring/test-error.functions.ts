import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// The "send a test error" button on /platform/health, server half. Platform
// admins only: checked here, not just by the route, because a server function
// is an endpoint anyone signed in can call.
//
// Sends one event whatever policy.isExpectedError would say about it, and
// answers whether monitoring is on in this deployment, so the page can tell
// "sent, go and look in Sentry" from "off here" (dev, or SENTRY_DSN=off).
export const sendMonitoringTestError = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { data, error } = await context.supabase.rpc("is_platform_admin", {
      _user_id: context.userId,
    });
    if (error) throw new Error(error.message);
    if (!data) throw new Error("Forbidden");

    const [{ sendServerTestError }, { getRequest }] = await Promise.all([
      import("./report.server"),
      import("@tanstack/react-start/server"),
    ]);
    const sent = await sendServerTestError(getRequest() ?? null);
    return { sent };
  });
