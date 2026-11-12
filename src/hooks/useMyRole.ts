import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";
import { ALL_PERMISSIONS, hasPermission, type Permission } from "@/lib/permissions";

export type AppRole = "owner" | "office_manager" | "dispatcher" | "tech";

export function useMyRole(): {
  role: AppRole | null;
  orgId: string | null;
  loading: boolean;
  /** The owner turned this person's access off since the shell loaded. */
  accessTurnedOff: boolean;
  /**
   * What this person can do, as the server worked it out from their role
   * and what the owner changed for it (#863). Null until getMyOrg has
   * answered, or when an older server did not say: then usePermissions
   * answers from the role's defaults.
   */
  permissions: Permission[] | null;
} {
  const fn = useServerFn(getMyOrg);
  const { data, isLoading } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  const role = (data?.organization?.role as AppRole | undefined) ?? null;
  const orgId = data?.organization?.id ?? null;
  return {
    role,
    orgId,
    loading: isLoading,
    accessTurnedOff: !!data?.accessTurnedOff,
    permissions: permissionsOf(data?.organization),
  };
}

/** The server's list, when it sent one and it is a list of real permissions. */
export function permissionsOf(org: unknown): Permission[] | null {
  const raw = (org as { permissions?: unknown } | null | undefined)?.permissions;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (p): p is Permission => typeof p === "string" && (ALL_PERMISSIONS as string[]).includes(p),
  );
}

/**
 * Action-level permission check for UI gating (hiding controls the caller
 * can't use). This is cosmetic — the same capability is enforced server-side
 * by requirePermission; never rely on this alone.
 *
 * Reads the configured set (#863): the server's list of what this person
 * can do, which already has the owner's changes for their role folded in.
 * Before that list arrives, or against a server that does not send one,
 * the role's defaults.
 */
export function usePermissions(): {
  can: (permission: Permission) => boolean;
  role: AppRole | null;
  loading: boolean;
} {
  const { role, loading, permissions } = useMyRole();
  return {
    can: (permission) =>
      permissions ? permissions.includes(permission) : hasPermission(role, permission),
    role,
    loading,
  };
}

// Route → minimum roles allowed. Undefined = everyone signed in.
export const ROUTE_ROLES: Record<string, AppRole[]> = {
  "/dashboard": ["owner", "office_manager", "dispatcher"],
  "/leads": ["owner", "office_manager"],
  "/clients": ["owner", "office_manager", "dispatcher"],
  // The server gate is send_campaigns, which owner and office_manager hold.
  "/campaigns": ["owner", "office_manager"],
  "/zones": ["owner", "office_manager", "dispatcher"],
  // Prices, not routing: a dispatcher moves visits around and has no reason
  // to see what every customer pays.
  "/pricing-drift": ["owner", "office_manager"],
  "/routes": ["owner", "office_manager", "dispatcher"],
  "/my-day": ["owner", "office_manager", "dispatcher", "tech"],
  // The technician's own forward view. Deliberately a DIFFERENT entry from
  // "/routes", which stays office-only: that page is the dispatch board and
  // exists to move work between people. This one reads the signed-in tech's
  // own staff row and returns counts, so the office roles get it too — an
  // owner who also drives is the ordinary case in a one-truck business.
  "/my-schedule": ["owner", "office_manager", "dispatcher", "tech"],
  "/waste-log": ["owner", "office_manager", "dispatcher", "tech"],
  "/messages": ["owner", "office_manager", "dispatcher"],
  // The office's worklist across Messages, Concerns, Needs review, Disputes
  // and alerts. The roles that can open at least two of those; each section
  // inside is drawn only for a role that can open its own page.
  "/inbox": ["owner", "office_manager", "dispatcher"],
  "/notifications": ["owner", "office_manager", "dispatcher", "tech"],
  "/concerns": ["owner", "office_manager", "dispatcher"],
  // Every running training package and which are low. The roles that open a
  // client's Services tab, where each row leads.
  "/training-packages": ["owner", "office_manager", "dispatcher"],
  "/inventory": ["owner", "office_manager"],
  // Payroll input. The same audience as the server gate, which is
  // manage_users -- the permission that also lets a person see and change the
  // team, and the one the time_entries policy asks.
  "/timesheets": ["owner", "office_manager"],
  // Everyone, because the page is two pages: the office (view_financials)
  // sees and edits the org's expenses, anybody else only their own. That
  // split is the expenses table's RLS, not this list.
  "/expenses": ["owner", "office_manager", "dispatcher", "tech"],
  "/invoices": ["owner", "office_manager"],
  // Same audience as the server gate, manage_client_billing, which is the
  // permission manual invoices use.
  "/quotes": ["owner", "office_manager"],
  "/billing": ["owner"],
  "/payments": ["owner"],
  "/onboarding": ["owner"],
  // The guided setup (src/lib/setup-guide.ts). The people who can set a
  // business up: every step's own server gate admits both, except payouts,
  // which the page filters out for an office manager by its own gate.
  "/setup": ["owner", "office_manager"],
  // Must precede the "/settings" prefix entry — canAccess takes the first match.
  "/settings/billing": ["owner"],
  // Outbound webhooks send the tenant's events to a third party: the same
  // audience as the server gate, manage_settings.
  "/settings/webhooks": ["owner", "office_manager"],
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
  // The business half of what was Preferences (time zone, standard pricing,
  // commercial accounts, completion rules, re-clean guarantee). Office only:
  // a technician reaches Preferences, which is their own device. Must precede
  // the "/settings" prefix entry.
  "/settings/business": ["owner", "office_manager"],
  // The service catalog. Same audience as its server gate, manage_pricing,
  // which a dispatcher does not hold. Must precede the "/settings" prefix.
  "/settings/services": ["owner", "office_manager"],
  // Roles & permissions (#863): who can do what, for every other role. The
  // owner alone, so a business cannot be locked out of its own settings by
  // somebody it gave manage_settings to. Must precede the "/settings" prefix.
  "/settings/roles": ["owner"],
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
  if (
    role === "tech" &&
    /^\/clients\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(path)
  ) {
    return true;
  }
  const key = Object.keys(ROUTE_ROLES).find((k) => path === k || path.startsWith(k + "/"));
  if (!key) return true;
  return ROUTE_ROLES[key].includes(role);
}

/**
 * Where a role is sent from a page it may not open, or null when it may open
 * it (or the path is not one ROUTE_ROLES guards). Techs land on /my-day;
 * everyone else on /dashboard.
 */
export function deniedRouteDestination(
  role: AppRole | null,
  pathname: string,
): "/my-day" | "/dashboard" | null {
  if (!role) return null;
  const guarded = Object.keys(ROUTE_ROLES).some(
    (k) => pathname === k || pathname.startsWith(k + "/"),
  );
  if (!guarded || canAccess(role, pathname)) return null;
  const dest = role === "tech" ? "/my-day" : "/dashboard";
  return pathname === dest ? null : dest;
}
