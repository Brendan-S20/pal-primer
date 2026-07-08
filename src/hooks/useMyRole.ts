import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";
import { hasPermission, type Permission } from "@/lib/permissions";

export type AppRole = "owner" | "office_manager" | "dispatcher" | "tech";

export function useMyRole(): { role: AppRole | null; orgId: string | null; loading: boolean } {
  const fn = useServerFn(getMyOrg);
  const { data, isLoading } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  const role = (data?.organization?.role as AppRole | undefined) ?? null;
  const orgId = data?.organization?.id ?? null;
  return { role, orgId, loading: isLoading };
}

/**
 * Action-level permission check for UI gating (hiding controls the caller
 * can't use). This is cosmetic — the same capability is enforced server-side
 * by requirePermission; never rely on this alone.
 */
export function usePermissions(): {
  can: (permission: Permission) => boolean;
  role: AppRole | null;
  loading: boolean;
} {
  const { role, loading } = useMyRole();
  return { can: (permission) => hasPermission(role, permission), role, loading };
}

// Route → minimum roles allowed. Undefined = everyone signed in.
export const ROUTE_ROLES: Record<string, AppRole[]> = {
  "/dashboard": ["owner", "office_manager", "dispatcher"],
  "/leads": ["owner", "office_manager"],
  "/clients": ["owner", "office_manager", "dispatcher"],
  "/zones": ["owner", "office_manager", "dispatcher"],
  "/routes": ["owner", "office_manager", "dispatcher"],
  "/weather": ["owner", "office_manager", "dispatcher"],
  "/my-day": ["owner", "office_manager", "dispatcher", "tech"],
  "/waste-log": ["owner", "office_manager", "dispatcher", "tech"],
  "/messages": ["owner", "office_manager", "dispatcher"],
  "/inventory": ["owner", "office_manager"],
  "/invoices": ["owner", "office_manager"],
  "/billing": ["owner"],
  "/reports": ["owner", "office_manager"],
  "/analytics": ["owner", "office_manager"],
  "/franchise": ["owner"],
  "/ai-tools": ["owner", "office_manager"],
  "/imports": ["owner", "office_manager"],
  "/settings": ["owner", "office_manager", "tech"],
  "/neighbors": ["owner", "office_manager", "dispatcher", "tech"],
  "/dna": ["owner", "office_manager", "dispatcher", "tech"],
};

export function canAccess(role: AppRole | null, path: string): boolean {
  if (!role) return false;
  const key = Object.keys(ROUTE_ROLES).find(
    (k) => path === k || path.startsWith(k + "/"),
  );
  if (!key) return true;
  return ROUTE_ROLES[key].includes(role);
}
