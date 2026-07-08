import type { AppRole } from "@/hooks/useMyRole";

/**
 * Action-level capabilities, checked at the point of each sensitive read or
 * write (server functions + DB policies), not just at route level.
 *
 * This matrix is mirrored in SQL by public.has_permission() — keep the two in
 * sync when adding a capability or changing a role's grants.
 */
export type Permission =
  | "manage_pricing" // zones create/edit/delete (incl. rates)
  | "manage_client_billing" // invoices, add-on charges/subscriptions, void, prepaid, credit
  | "view_financials" // dashboard revenue/AR KPIs, reports, analytics
  | "view_client_directory" // client names/addresses beyond the caller's own assigned work
  | "manage_dna_billing" // set DNA fine amounts, mark billed, generate violation invoices
  | "record_field_addons" // capped, confirmed add-on charge from a visit (source=field)
  | "manage_org_billing" // the org's own SaaS plan / Stripe
  | "manage_leads"
  | "manage_imports"
  | "use_ai_tools"
  | "manage_inventory"
  | "manage_franchise"
  | "manage_users"
  | "manage_settings";

const ALL_PERMISSIONS: Permission[] = [
  "manage_pricing",
  "manage_client_billing",
  "view_financials",
  "view_client_directory",
  "manage_dna_billing",
  "record_field_addons",
  "manage_org_billing",
  "manage_leads",
  "manage_imports",
  "use_ai_tools",
  "manage_inventory",
  "manage_franchise",
  "manage_users",
  "manage_settings",
];

export const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  office_manager: ALL_PERMISSIONS.filter(
    (p) => p !== "manage_org_billing" && p !== "manage_franchise",
  ),
  dispatcher: ["view_client_directory", "record_field_addons"],
  tech: ["record_field_addons"],
};

export function hasPermission(role: AppRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
