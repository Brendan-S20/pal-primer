// Shared "humanize" layer (QA finding #19): admin-facing surfaces were rendering
// raw backend values — snake_case role enums ("office_manager"), DB table names,
// and internal roadmap notes — directly to users. Route labels through here so
// they read as product copy everywhere. The tenant Settings → Users & roles page
// is the reference for role labels.

const ROLE_LABELS: Record<string, string> = {
  owner: "Owner",
  office_manager: "Office manager",
  dispatcher: "Dispatcher",
  tech: "Technician",
  platform_admin: "Platform admin",
};

/** Human-readable label for a role enum value. */
export function humanizeRole(role: string | null | undefined): string {
  if (!role) return "-";
  return ROLE_LABELS[role] ?? humanizeEnum(role);
}

/** Generic snake_case → "Sentence case" for any unmapped enum value. */
export function humanizeEnum(value: string | null | undefined): string {
  if (!value) return "-";
  const spaced = value.replace(/_/g, " ").trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** Platform-admin audit-log action names. The audit UI rendered raw enums like
 *  "start_impersonation" (H2 finding); route them through here so the log reads
 *  as product copy. Unmapped actions fall back to humanizeEnum. */
const AUDIT_ACTION_LABELS: Record<string, string> = {
  start_impersonation: "Started impersonation",
  enter_impersonation: "Entered impersonation session",
  stop_impersonation: "Ended impersonation",
  update_org_plan: "Updated plan",
  suspend_org: "Suspended organization",
  unsuspend_org: "Restored organization",
  delete_org: "Deleted organization",
};

export function humanizeAuditAction(action: string | null | undefined): string {
  if (!action) return "-";
  return AUDIT_ACTION_LABELS[action] ?? humanizeEnum(action);
}
