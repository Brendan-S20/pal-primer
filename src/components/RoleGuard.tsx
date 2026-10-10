import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMyRole, canAccess, ROUTE_ROLES } from "@/hooks/useMyRole";
import { toast } from "sonner";

/**
 * Redirects the user away from routes they lack permission for.
 * Techs land on /my-day; everyone else on /dashboard.
 */
export function RoleGuard() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role, loading, accessTurnedOff } = useMyRole();

  // Turned off while already inside: the shell's check ran when the app
  // opened, and on a phone that can be days ago. ["my-org"] refetches when it
  // goes stale and the app comes back to the foreground; the first answer
  // that says "off" ends the session's view of the business.
  useEffect(() => {
    if (accessTurnedOff) navigate({ to: "/access-off", replace: true });
  }, [accessTurnedOff, navigate]);

  useEffect(() => {
    if (loading || !role) return;
    // Only guard known routes
    const guarded = Object.keys(ROUTE_ROLES).some(
      (k) => pathname === k || pathname.startsWith(k + "/"),
    );
    if (!guarded) return;
    if (!canAccess(role, pathname)) {
      const dest = role === "tech" ? "/my-day" : "/dashboard";
      if (pathname !== dest) {
        toast.error("You don't have access to that page.");
        navigate({ to: dest, replace: true });
      }
    }
  }, [role, loading, pathname, navigate]);

  return null;
}
