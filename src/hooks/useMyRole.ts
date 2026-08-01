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
  "/my-day": ["owner", "office_manager", "dispatcher", "tech"],
  "/waste-log": ["owner", "office_manager", "dispatcher", "tech"],
  "/messages": ["owner", "office_manager", "dispatcher"],
  "/notifications": ["owner", "office_manager", "dispatcher", "tech"],
  "/concerns": ["owner", "office_manager", "dispatcher"],
  "/inventory": ["owner", "office_manager"],
  "/invoices": ["owner", "office_manager"],
  "/billing": ["owner"],
  "/payments": ["owner"],
  "/onboarding": ["owner"],
  // Must precede the "/settings" prefix entry — canAccess takes the first match.
  "/settings/billing": ["owner"],
  // Client-invoicing config (net terms, grace, auto-send) — office-level money
  // settings, same audience as the Invoices page.
  "/settings/invoicing": ["owner", "office_manager"],
  // Referral rewards are real money to the business — keep it office-level.
  "/settings/referrals": ["owner", "office_manager"],
  "/reports": ["owner", "office_manager"],
  // BUILD-13: same audience as /reports, because the server gate is the same
  // (view_financials). Making the route stricter than the function behind it
  // would only hide the link from someone who could still fetch the data.
  "/tax-reports": ["owner", "office_manager"],
  // BUILD-12: same audience as the other money surfaces — the server gate is
  // view_financials, and a route stricter than the function behind it only
  // hides the link from someone who could still fetch the data.
  "/disputes": ["owner", "office_manager"],
  "/analytics": ["owner", "office_manager"],
  // BUILD-10: dispatchers and techs can SEE that a record is uncertain
  // (the list is gated on view_client_directory server-side), but only
  // office roles can record a decision. Route ACL matches the read gate.
  "/review": ["owner", "office_manager", "dispatcher"],
  "/franchise": ["owner"],
  // BUILD-6: the CHILD side. Deliberately NOT Enterprise-gated — a
  // franchisee is a location someone else recruited, most likely on a
  // cheaper plan. Gating it would make linking impossible unless every
  // location bought Enterprise too.
  "/settings/franchise": ["owner"],
  // /ai-tools is now a redirect to /dashboard — no ACL entry needed.
  "/imports": ["owner", "office_manager"],
  "/settings": ["owner", "office_manager", "tech"],
  "/neighbors": ["owner", "office_manager", "dispatcher", "tech"],
  // H1: the DNA compliance workspace (cross-client registry, fines, violation
  // notices) is office/dispatch only. Techs are redirected to /my-day and the
  // DNA read server fns reject them (I7).
  //
  // This comment used to say techs "are scoped to sample logging". They are
  // not — no tech-facing DNA affordance exists anywhere in the product, and
  // setDogDna requires can_write_org. The plan for it is in
  // docs/mobile-ux-audit.md §3.2 and it was never built (Q-5).
  //
  // Chasing that claim found something worse: every RLS policy on dna_matches
  // was `is_org_member`, which techs pass. Proven live — a tech could re-point
  // a $250 violation onto another client's dog, close it, and delete a sample
  // sitting at the lab, all without touching fine_cents, so the billing
  // trigger never fired. Closed in
  // 20260801021000_a-tech-could-rewrite-any-dna-violation.sql.
  "/dna": ["owner", "office_manager", "dispatcher"],
  "/help": ["owner", "office_manager", "dispatcher", "tech"],
};

export function canAccess(role: AppRole | null, path: string): boolean {
  if (!role) return false;
  const key = Object.keys(ROUTE_ROLES).find((k) => path === k || path.startsWith(k + "/"));
  if (!key) return true;
  return ROUTE_ROLES[key].includes(role);
}
