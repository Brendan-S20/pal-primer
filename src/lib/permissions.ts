import type { AppRole } from "@/hooks/useMyRole";

/**
 * Action-level capabilities, checked at the point of each sensitive read or
 * write (server functions + DB policies), not just at route level.
 *
 * This matrix is mirrored in SQL by public.permission_default(), which
 * public.has_permission() reads — keep the two in sync when adding a
 * capability or changing a role's grants (tests/permission-parity.test.ts).
 *
 * Since #863 the matrix is a DEFAULT. The owner of a business can turn any
 * permission on or off for office manager, dispatcher and tech on Settings →
 * Roles & permissions; the result is stored per business in
 * public.role_permission_overrides, and read by hasPermission() here (through
 * resolveCaller's `overrides`), by has_permission() in SQL, and by
 * usePermissions() in the browser. A business that never opens the screen
 * runs on exactly this matrix.
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
  // Closing a visit out from the office (#863, Brendan 2026-11-12 11:45 ET):
  // marking a stop complete for a technician, or canceling it at the
  // business's skip rules. Both can bill the client, which is why they sat
  // on manage_client_billing until then; they are their own permission so a
  // dispatcher can run the day without invoices, refunds, prepaid or credit.
  // Owner, office manager and dispatcher by default. A prepaid plan stays
  // manage_client_billing (PLAN_CADENCE_IS_BILLING in clients.functions.ts).
  | "close_visits"
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
  "close_visits",
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

/**
 * What each role holds when the owner has changed nothing (#863). This is
 * the rule set main shipped with on 2026-11-11, kept verbatim as the default
 * so nothing changes for a business until its owner changes something.
 */
export const ROLE_PERMISSIONS: Record<AppRole, readonly Permission[]> = {
  owner: ALL_PERMISSIONS,
  office_manager: ALL_PERMISSIONS.filter(
    (p) => p !== "manage_org_billing" && p !== "manage_franchise",
  ),
  // #728 (owner, 2026-11-08): "dispatcher role with its own permissions for
  // routes, clients and messaging". Nothing here touches the business's own
  // billing, security or who has access, and no price: manage_pricing,
  // manage_client_billing, manage_users and manage_settings stay off.
  // #863 (owner, 2026-11-12): a dispatcher completes a visit for a tech and
  // cancels one, so close_visits is on by default; a prepaid plan is not.
  dispatcher: [
    "view_client_directory",
    "record_field_addons",
    "booking",
    "manage_schedule",
    "close_visits",
    "message_clients",
    "manage_plans",
  ],
  tech: ["record_field_addons"],
};

/** The same matrix under the name the rest of #863 uses for it. */
export const DEFAULT_ROLE_PERMISSIONS = ROLE_PERMISSIONS;

/** The roles an owner can configure. The owner's own role is not on the
 *  list: an owner holds everything, always, and that is not a setting. */
export const CONFIGURABLE_ROLES = ["office_manager", "dispatcher", "tech"] as const;
export type ConfigurableRole = (typeof CONFIGURABLE_ROLES)[number];

export function isConfigurableRole(role: string): role is ConfigurableRole {
  return (CONFIGURABLE_ROLES as readonly string[]).includes(role);
}

/**
 * The floor no toggle can lift (#863): these stay with the owner whatever
 * the business sets, in TypeScript, in SQL (a CHECK on the overrides table
 * and the first clause of has_permission) and on the screen, where they are
 * listed without a switch.
 *
 *   manage_org_billing  the business's own HoundStack plan, its Stripe
 *                       account and Stripe Connect payouts: the money the
 *                       business itself is paid or charged.
 *   manage_franchise    joining a franchise or running one: what the business
 *                       answers to. A location, once added, cannot be removed
 *                       (tests/a-location-could-be-added-to-a-franchise-and-
 *                       never-removed), so handing it out is close to handing
 *                       out ownership.
 *
 * Changing or deactivating the owner, transferring ownership and deleting the
 * business are not permissions at all: set_staff_active, change_user_role and
 * the delete flow ask for the owner's role by name, and no override reaches
 * them. A tech's view of gate codes is a floor inside property_access_codes
 * and stay_access_codes (the assigned day only, even with
 * view_client_directory turned on).
 */
export const OWNER_ONLY_PERMISSIONS: readonly Permission[] = [
  "manage_org_billing",
  "manage_franchise",
];

export function isOwnerOnly(permission: Permission): boolean {
  return OWNER_ONLY_PERMISSIONS.includes(permission);
}

/**
 * A business's changes to one role: the permissions the owner turned on or
 * off, keyed by permission. Absent means "the default". Resolved per
 * (business, role) before it reaches hasPermission, so the TypeScript here
 * never has to know which business is asking.
 */
export type PermissionOverrides = Partial<Record<Permission, boolean>>;

/**
 * Does this role hold this permission? With no overrides, exactly the matrix
 * above. With the business's overrides:
 *
 *   * an owner holds everything, whatever is stored;
 *   * nobody else holds an owner-only permission, whatever is stored;
 *   * otherwise the stored answer wins, and a permission the owner has not
 *     touched is the default.
 */
export function hasPermission(
  role: AppRole | null | undefined,
  permission: Permission,
  overrides?: PermissionOverrides | null,
): boolean {
  if (!role) return false;
  if (role === "owner") return true;
  if (isOwnerOnly(permission)) return false;
  const stored = overrides?.[permission];
  if (typeof stored === "boolean") return stored;
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}

/** The server's list for the signed-in person (getMyOrg's `permissions`),
 *  when it sent one and it is a list of real permissions; null otherwise, so
 *  the browser falls back to the role's defaults. Here rather than in the
 *  hook module so a page can read it without the hooks a test double mocks. */
export function permissionsOf(org: unknown): Permission[] | null {
  const raw = (org as { permissions?: unknown } | null | undefined)?.permissions;
  if (!Array.isArray(raw)) return null;
  return raw.filter(
    (p): p is Permission => typeof p === "string" && (ALL_PERMISSIONS as string[]).includes(p),
  );
}

/**
 * hasPermission for a browser caller that holds the server's list
 * (usePermissions().permissions): the list when there is one, else the
 * role's defaults. For the pure helpers that take a role (refunds, tap to
 * pay, the CPA pack) so they read the configured set too (#863).
 */
export function holdsPermission(
  role: AppRole | null | undefined,
  permission: Permission,
  permissions?: readonly Permission[] | null,
): boolean {
  if (permissions) return permissions.includes(permission);
  return hasPermission(role, permission);
}

/** Everything a role holds, after the business's overrides. */
export function effectivePermissions(
  role: AppRole | null | undefined,
  overrides?: PermissionOverrides | null,
): Permission[] {
  return ALL_PERMISSIONS.filter((p) => hasPermission(role, p, overrides));
}

/**
 * Rows as public.role_permission_overrides stores them, folded into the map
 * hasPermission reads. Anything that is not a known permission with a
 * boolean is ignored rather than trusted: this is read through the same
 * client as everything else, and a malformed row must not become a grant.
 */
export function overridesFromRows(
  rows: ReadonlyArray<{ permission?: unknown; allowed?: unknown }> | null | undefined,
): PermissionOverrides {
  const out: PermissionOverrides = {};
  for (const row of rows ?? []) {
    if (typeof row?.permission !== "string" || typeof row.allowed !== "boolean") continue;
    if (!(ALL_PERMISSIONS as string[]).includes(row.permission)) continue;
    out[row.permission as Permission] = row.allowed;
  }
  return out;
}

// ── What the owner reads on the screen ──────────────────────────────────────
//
// One line per permission, in the owner's words rather than the code's. The
// Roles & permissions page draws these; nothing else should, so a change of
// wording is a change here.

export type PermissionGroup = "people" | "clients" | "schedule" | "money" | "business";

export const PERMISSION_GROUP_LABELS: Record<PermissionGroup, string> = {
  people: "Team",
  clients: "Clients and messages",
  schedule: "Schedule and routes",
  money: "Money",
  business: "Business settings",
};

export const PERMISSION_CATALOG: ReadonlyArray<{
  permission: Permission;
  label: string;
  explanation: string;
  group: PermissionGroup;
}> = [
  {
    permission: "manage_users",
    label: "Manage the team",
    explanation:
      "Invite people, change their roles and turn them off or on. Never the owner, and never a role above their own.",
    group: "people",
  },
  {
    permission: "view_client_directory",
    label: "See every client",
    explanation:
      "Client names, addresses and notes beyond their own assigned visits. Gate codes stay on the assigned day for a technician.",
    group: "clients",
  },
  {
    permission: "booking",
    label: "Book at the set price",
    explanation: "Book, rebook or add a one-off visit at the price the business already set.",
    group: "schedule",
  },
  {
    permission: "manage_schedule",
    label: "Move visits",
    explanation: "Move a booked visit to another day from the office, at the price it already has.",
    group: "schedule",
  },
  {
    permission: "close_visits",
    label: "Complete or cancel a visit from the office",
    explanation:
      "Mark a visit complete for a technician, or cancel it at the business's skip rules. Both can bill the client.",
    group: "schedule",
  },
  {
    permission: "manage_plans",
    label: "Manage plans at the set price",
    explanation:
      "Add, pause, resume or end a plan on an existing client at the price the business already set. Typing a price, editing or deleting a plan stays with Set prices.",
    group: "schedule",
  },
  {
    permission: "message_clients",
    label: "Message clients",
    explanation: "Text one client from their Messages tab or the inbox.",
    group: "clients",
  },
  {
    permission: "send_campaigns",
    label: "Send campaigns",
    explanation: "Email or text many clients at once.",
    group: "clients",
  },
  {
    permission: "manage_leads",
    label: "Work leads",
    explanation: "See and work the leads list and convert a lead into a client.",
    group: "clients",
  },
  {
    permission: "reveal_signin_code",
    label: "Read a portal sign-in code",
    explanation:
      "Read a client's working portal sign-in code aloud. Confirmed and logged each time.",
    group: "clients",
  },
  {
    permission: "manage_pricing",
    label: "Set prices",
    explanation:
      "Create and change zones and rates, and type a price by hand on a plan or booking.",
    group: "money",
  },
  {
    permission: "manage_client_billing",
    label: "Bill clients",
    explanation: "Invoices, refunds, add-on charges, prepaid plans and credit.",
    group: "money",
  },
  {
    permission: "view_financials",
    label: "See the money",
    explanation: "Revenue and receivables on the dashboard, reports and analytics.",
    group: "money",
  },
  {
    permission: "record_field_addons",
    label: "Record an add-on from a visit",
    explanation: "Add a capped, confirmed extra charge while on a visit.",
    group: "money",
  },
  {
    permission: "manage_dna_billing",
    label: "Bill DNA violations",
    explanation: "Set DNA fine amounts, mark samples billed and send violation invoices.",
    group: "money",
  },
  {
    permission: "manage_settings",
    label: "Change business settings",
    explanation: "Business defaults, scheduling, the portal, texting, emails and automation.",
    group: "business",
  },
  {
    permission: "manage_imports",
    label: "Import clients",
    explanation: "Bring clients in from a spreadsheet or another product.",
    group: "business",
  },
  {
    permission: "manage_inventory",
    label: "Manage inventory",
    explanation: "Supplies and stock levels.",
    group: "business",
  },
  {
    permission: "use_ai_tools",
    label: "Use the AI tools",
    explanation: "The AI receptionist and drafting tools, within the plan's allowance.",
    group: "business",
  },
  {
    permission: "manage_org_billing",
    label: "The business's own plan and payouts",
    explanation:
      "The HoundStack plan, the Stripe account and Stripe Connect payouts. Always the owner.",
    group: "business",
  },
  {
    permission: "manage_franchise",
    label: "Franchise",
    explanation: "Join a franchise or run one. Always the owner.",
    group: "business",
  },
];
