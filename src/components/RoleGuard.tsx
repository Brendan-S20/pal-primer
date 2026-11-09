import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMyRole, deniedRouteDestination } from "@/hooks/useMyRole";
import { toast } from "sonner";

/**
 * Redirects the user away from routes they lack permission for.
 *
 * Reads the RESOLVED location, once the router is idle (#682). The router
 * sets the location as soon as a navigation starts, and navigating from here
 * at that moment ran over a load still in flight. The shell draws neither
 * itself nor the page while this decides; see AppShell.
 */
export function RoleGuard() {
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (r) => (r.status === "idle" ? r.resolvedLocation?.pathname : undefined),
  });
  const { role, loading, accessTurnedOff } = useMyRole();

  // Turned off while already inside: the shell's check ran when the app
  // opened, and on a phone that can be days ago. ["my-org"] refetches when it
  // goes stale and the app comes back to the foreground; the first answer
  // that says "off" ends the session's view of the business.
  useEffect(() => {
    if (accessTurnedOff) navigate({ to: "/access-off", replace: true });
  }, [accessTurnedOff, navigate]);

  useEffect(() => {
    if (loading || !role || !pathname) return;
    const dest = deniedRouteDestination(role, pathname);
    if (dest) {
      toast.error("You don't have access to that page.");
      navigate({ to: dest, replace: true });
    }
  }, [role, loading, pathname, navigate]);

  return null;
}
