import type { AppRole } from "@/hooks/useMyRole";

/**
 * Action-level capabilities, checked at the point of each sensitive read or
 * write (server functions + DB policies), not just at route level.
 *
 * This matrix is mirrored in SQL by public.has_permission() — keep the two in
 * sync when adding a capability or changing a role's grants.
 */
export type Permission =
  | "manage_pricing" // zones create/edit/delete (incl. rates), and any price typed by hand
  // Booking a visit or a groom for a client at the price the business already
  // set (#616). Owner and office manager hold it with everything else; a
  // dispatcher holds it so the front desk can book, rebook and add a one-off.
  // It sets no price: a price that differs from the set one is still
  // manage_pricing, and the server refuses it to anyone without that.
  | "booking"
  // Moving booked work on the schedule from the office (#728): a visit to
  // another day, at the price it already has. Owner and office manager hold
  // it with everything else; a dispatcher holds it because routes are their
  // job. It moves no money and sets no price: completing or canceling a
  // visit, which can bill, stays manage_client_billing.
  | "manage_schedule"
  // Writing to one client (#728): a text from the client's Messages tab or
  // the inbox. Owner, office manager and dispatcher. A message to many
  // clients at once is send_campaigns, which a dispatcher does not hold.
  | "message_clients"
  // Running an existing client's recurring plans (#728, owner decision
  // 2026-11-10: "Yes, dispatchers can manage plans at the set price"): add a
  // plan at the business's set price, pause it, resume it, end it. Owner and
  // office manager hold it with everything else; a dispatcher holds it as
  // their default (#863 will let the owner change that). It sets no price: a
  // plan at any other price, a discount, an edit of a plan's price or terms,
  // billing in advance and deleting a plan stay manage_pricing, and the
  // server refuses them to anyone without it.
  | "manage_plans"
  | "manage_client_billing" // invoices, add-on charges/subscriptions, void, prepaid, credit
  | "view_financials" // dashboard revenue/AR KPIs, reports, analytics
  | "view_client_directory" // client names/addresses beyond the caller's own assigned work
  | "manage_dna_billing" // set DNA fine amounts, mark billed, generate violation invoices
  | "reveal_signin_code" // read a client's active portal sign-in code aloud (G2 — owner/office_manager only, confirmed + logged)
  | "record_field_addons" // capped, confirmed add-on charge from a visit (source=field)
  | "manage_org_billing" // the org's own SaaS plan / Stripe
  | "manage_leads"
  // Email campaigns: a marketing email to many clients at once. Its own
  // capability rather than manage_settings because it is not a setting: it
  // is the business speaking to every customer in one press. Owner and office
  // manager, which has_permission already grants (office_manager holds every
  // permission except the two it names), so the SQL needs no change.
  | "send_campaigns"
  | "manage_imports"
  | "use_ai_tools"
  | "manage_inventory"
  | "manage_franchise"
  | "manage_users"
  | "manage_settings";

/** Every permission the product defines. Exported so the TS↔SQL parity
 *  test (IMP-3) can enumerate the matrix exhaustively rather than spot-check
 *  it — a permission missing from one side is exactly the drift it guards. */
export const ALL_PERMISSIONS: Permission[] = [
  "manage_pricing",
  "booking",
  "manage_schedule",
  "message_clients",
  "manage_plans",
  "manage_client_billing",
  "view_financials",
  "view_client_directory",
  "manage_dna_billing",
  "reveal_signin_code",
  "record_field_addons",
  "manage_org_billing",
  "manage_leads",
  "send_campaigns",
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
  // #728 (owner, 2026-11-08): "dispatcher role with its own permissions for
  // routes, clients and messaging". Nothing here touches the business's own
  // billing, security or who has access, and no price: manage_pricing,
  // manage_client_billing, manage_users and manage_settings stay off.
  dispatcher: [
    "view_client_directory",
    "record_field_addons",
    "booking",
    "manage_schedule",
    "message_clients",
    "manage_plans",
  ],
  tech: ["record_field_addons"],
};

export function hasPermission(role: AppRole | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
