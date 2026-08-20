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
 *  as product copy. Unmapped actions fall back to humanizeEnum.
 *
 *  That fallback is why this drifted for so long without anyone noticing: it
 *  never breaks, it just reads slightly wrong. `end_grace_period` rendered as
 *  "End grace period" — present tense in a log of things that already happened,
 *  next to "Granted grace period" — and `mirror_plan_to_stripe` rendered with a
 *  lower-case "stripe". Nineteen actions the code can write had no entry here,
 *  two of them already in the production log (`create_coupon`,
 *  `approve_signup_request`).
 *
 *  `tests/every-audit-action-has-a-label.test.ts` now extracts the action
 *  strings from the call sites and requires each one to appear below, so the
 *  next `audit(...)` call added anywhere is told about this map.
 *
 *  Exported for that test. Entries are NOT removed when a caller goes away:
 *  rows already written to `platform_admin_audit` still have to render, and the
 *  log is append-only history. */
export const AUDIT_ACTION_LABELS: Record<string, string> = {
  start_impersonation: "Started impersonation",
  enter_impersonation: "Entered impersonation session",
  stop_impersonation: "Ended impersonation",
  update_org_plan: "Updated plan",
  suspend_org: "Suspended organization",
  unsuspend_org: "Restored organization",
  delete_org: "Deleted organization",
  update_plan: "Edited plan catalog entry",
  update_addon_status: "Changed add-on availability",
  send_password_reset: "Sent password reset",
  update_user_email: "Changed user email",
  update_user_phone: "Changed user phone",
  remove_user_mfa: "Removed user MFA",
  suspend_tenant: "Suspended tenant",
  reactivate_tenant: "Reactivated tenant",
  grant_grace_period: "Granted grace period",
  soft_delete_tenant: "Deleted tenant (soft)",
  signup_promo_captured: "Captured signup promo code",
  signup_promo_applied: "Applied signup promo code",
  // Added 2026-08-20. Everything below was reachable from the code and had no
  // label; the first two already had rows in the production log.
  create_coupon: "Created coupon",
  approve_signup_request: "Approved signup request",
  accept_invite: "Accepted invite",
  add_support_note: "Added support note",
  delete_support_note: "Deleted support note",
  billing_status_change: "Billing status changed",
  clear_feature_flag: "Cleared feature flag",
  create_announcement: "Created announcement",
  create_invite: "Created invite",
  create_plan: "Created plan catalog entry",
  delete_announcement: "Deleted announcement",
  end_grace_period: "Ended grace period",
  mirror_plan_to_stripe: "Mirrored plan to Stripe",
  reassign_all_billing_tiers: "Reassigned all billing tiers",
  referral_settings_update: "Updated referral settings",
  resend_invite: "Resent invite",
  restore_tenant: "Restored tenant",
  revoke_invite: "Revoked invite",
  send_announcement_emails: "Sent announcement emails",
  set_feature_flag: "Changed feature flag",
};

export function humanizeAuditAction(action: string | null | undefined): string {
  if (!action) return "-";
  return AUDIT_ACTION_LABELS[action] ?? humanizeEnum(action);
}
