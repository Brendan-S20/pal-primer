// No visitor or signed-in user can empty a public table (#842).
//
// Supabase's default privileges give anon and authenticated TRUNCATE, TRIGGER
// and REFERENCES on every public table, and RLS does not protect TRUNCATE. A
// census of production on 2026-11-10 (after #760) found 106 tables, 575 grant
// rows, still holding them. 20261110130000 revokes them, and two checks keep
// them from coming back:
//
//   * supabase/proofs/20261110130000-…sql, on the schema the migrations
//     build (sandboxes.yml runs every proof), with mutations that put a grant
//     back and show it is named;
//   * scripts/check-public-table-grants.mjs, against production, in ci.yml's
//     "Migrations applied to the live database" job.
//
// This file pins the shape: the migration names exactly the census's 106
// tables and none of the 37 already clean, revokes those three privileges and
// nothing else, and both checks look at every public table rather than a list.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const codeOnly = (sql: string) =>
  sql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");

const MIGRATION = codeOnly(
  read(
    "supabase/migrations/20261110130000_no-visitor-or-signed-in-user-can-empty-a-public-table.sql",
  ),
);
const PROOF = codeOnly(
  read("supabase/proofs/20261110130000-no-visitor-or-signed-in-user-can-empty-a-public-table.sql"),
);
const CHECK = read("scripts/check-public-table-grants.mjs");
const WORKFLOW = read(".github/workflows/ci.yml");

// From #842: both anon and authenticated held all three.
const BOTH = [
  "account_deletion_schedule",
  "activity_log",
  "addon_charges",
  "addon_requests",
  "addon_services",
  "addon_subscriptions",
  "ai_receptionist_logs",
  "app_notification_prefs",
  "app_notifications",
  "blackout_dates",
  "client_holds",
  "client_notes",
  "clients",
  "credit_ledger",
  "dna_matches",
  "dogs",
  "email_send_log",
  "email_send_state",
  "email_unsubscribe_tokens",
  "email_verifications",
  "founding_accounts",
  "franchise_adjustments",
  "franchise_link_codes",
  "franchise_royalty_invoices",
  "gift_card_redemptions",
  "gift_cards",
  "impersonation_grants",
  "import_batches",
  "import_rows",
  "inventory_assignments",
  "inventory_items",
  "inventory_movements",
  "invoice_line_items",
  "invoices",
  "leads",
  "locations",
  "messages",
  "neighbor_leads",
  "org_invites",
  "org_platform_addons",
  "org_texting_registrations",
  "org_twilio_credentials",
  "organizations",
  "payments",
  "platform_addons",
  "platform_admin_audit",
  "platform_admins",
  "platform_announcement_reads",
  "platform_announcements",
  "platform_coupons",
  "platform_feature_flags",
  "platform_invites",
  "platform_invoices",
  "platform_org_feature_flags",
  "platform_plans",
  "platform_referral_settings",
  "platform_signup_requests",
  "platform_stripe_events",
  "platform_support_notes",
  "portal_code_attempts",
  "portal_otps",
  "portal_sessions",
  "promo_codes",
  "properties",
  "property_units",
  "push_subscriptions",
  "qc_tickets",
  "road_legs",
  "roadmap_vote_throttle",
  "roadmap_votes",
  "signup_requests",
  "skip_billing_rules",
  "sms_consent_records",
  "staff",
  "station_service_logs",
  "subscriptions",
  "suppressed_emails",
  "tenant_referrals",
  "unit_incidents",
  "user_roles",
  "visit_photos",
  "visits",
  "waste_disposal_facilities",
  "waste_disposal_manifests",
  "waste_stations",
  "zones",
];

// From #842: only authenticated held all three.
const AUTHENTICATED_ONLY = [
  "ai_usage_events",
  "ai_usage_periods",
  "client_packages",
  "directory_profile_services",
  "directory_profiles",
  "expenses",
  "holiday_dates",
  "homework",
  "pet_care_instructions",
  "pet_vaccinations",
  "review_items",
  "service_packages",
  "session_progress",
  "staff_time_off",
  "stays",
  "training_session_notes",
  "training_skills",
  "walk_groups",
  "weather_forecast_cache",
];

// From #842: authenticated held REFERENCES and TRIGGER only.
const REFERENCES_AND_TRIGGER = ["time_entries"];

// From #842: already clean, each through the REVOKE ALL in the migration that
// created it. Nothing here may grant them anything back.
const ALREADY_CLEAN = [
  "accounting_connections",
  "accounting_sync_log",
  "ai_receptionist_offers",
  "calendar_feeds",
  "care_log",
  "client_unsubscribe_tokens",
  "directory_reviews",
  "email_campaign_recipients",
  "email_campaigns",
  "field_collections",
  "live_activity_action_tokens",
  "live_activity_actions",
  "live_activity_tokens",
  "oauth_states",
  "org_vaccine_policy_changes",
  "pet_groom_notes",
  "pet_safety_entries",
  "platform_service_lines",
  "portal_change_fee_charges",
  "portal_change_fee_events",
  "portal_change_requests",
  "portal_change_rules",
  "public_form_attempts",
  "quote_line_items",
  "quotes",
  "road_leg_runs",
  "routing_run_undo",
  "routing_runs",
  "service_size_rules",
  "services",
  "staff_services",
  "training_package_notices",
  "visit_live_locations",
  "webhook_deliveries",
  "webhook_endpoint_secrets",
  "webhook_endpoints",
  "website_submissions",
];

const AFFECTED = [...BOTH, ...AUTHENTICATED_ONLY, ...REFERENCES_AND_TRIGGER];

/** Every `public.<name>` a REVOKE in the migration names. */
const revoked = () => {
  const names: string[] = [];
  for (const stmt of MIGRATION.match(/REVOKE[^;]*;/g) ?? []) {
    for (const m of stmt.matchAll(/public\.([a-z_][a-z0-9_]*)/g)) names.push(m[1]);
  }
  return names;
};

describe("the census", () => {
  it("is 106 affected tables in three groups and 37 clean ones, with no overlap", () => {
    expect(BOTH).toHaveLength(86);
    expect(AUTHENTICATED_ONLY).toHaveLength(19);
    expect(REFERENCES_AND_TRIGGER).toHaveLength(1);
    expect(new Set(AFFECTED).size).toBe(106);
    expect(new Set(ALREADY_CLEAN).size).toBe(37);
    expect(AFFECTED.filter((t) => ALREADY_CLEAN.includes(t))).toEqual([]);
  });
});

describe("the migration", () => {
  it("revokes from every affected table, once", () => {
    const names = revoked();
    expect([...names].sort()).toEqual([...AFFECTED].sort());
  });

  it("names none of the tables that were already clean", () => {
    expect(revoked().filter((t) => ALREADY_CLEAN.includes(t))).toEqual([]);
  });

  it("revokes exactly TRUNCATE, TRIGGER and REFERENCES, from both client roles", () => {
    const stmts = MIGRATION.match(/REVOKE[^;]*;/g) ?? [];
    expect(stmts).toHaveLength(3);
    for (const s of stmts) {
      expect(s).toMatch(/^REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE\s/);
      expect(s).toMatch(/\sFROM anon, authenticated;$/);
    }
  });

  it("grants nothing and leaves RLS and policies alone", () => {
    expect(MIGRATION).not.toMatch(/^\s*GRANT\b/im);
    expect(MIGRATION).not.toMatch(/^\s*(CREATE|ALTER|DROP) POLICY\b/im);
    expect(MIGRATION).not.toMatch(/^\s*ALTER TABLE\b/im);
    expect(MIGRATION).not.toMatch(/REVOKE\s+(ALL|SELECT|INSERT|UPDATE|DELETE)\b/i);
  });

  it("asserts the end state over every public table, not just the ones it names", () => {
    expect(MIGRATION).toMatch(/DO \$verify\$/);
    expect(MIGRATION).toMatch(/relnamespace = 'public'::regnamespace/);
    expect(MIGRATION).toMatch(/has_table_privilege\(r\.role, c\.oid, p\.priv\)/);
    expect(MIGRATION).toMatch(/RAISE EXCEPTION/);
  });
});

describe("the proof", () => {
  it("checks every public base table, for both roles and all three privileges", () => {
    expect(PROOF).toMatch(/relnamespace = 'public'::regnamespace/);
    expect(PROOF).toMatch(/relkind IN \('r', 'p'\)/);
    expect(PROOF).toMatch(/\('anon'\), \('authenticated'\)/);
    expect(PROOF).toMatch(/\('TRUNCATE'\), \('TRIGGER'\), \('REFERENCES'\)/);
    expect(PROOF).toMatch(/has_table_privilege\(/);
  });

  it("proves it looked at the directory_* and portal_* tables", () => {
    for (const t of [
      "directory_profiles",
      "directory_profile_services",
      "directory_reviews",
      "portal_sessions",
    ]) {
      expect(PROOF).toContain(`'${t}'`);
    }
  });

  it("puts grants back, directly and through PUBLIC, and requires each to be named", () => {
    expect(PROOF).toMatch(/GRANT TRUNCATE ON TABLE public\.directory_profiles TO authenticated;/);
    expect(PROOF).toMatch(/GRANT REFERENCES ON TABLE public\.portal_sessions TO anon;/);
    expect(PROOF).toMatch(/GRANT TRIGGER ON TABLE public\.clients TO PUBLIC;/);
    expect(PROOF).toMatch(/INCONCLUSIVE/);
    expect(PROOF).toMatch(/ROLLBACK TO SAVEPOINT mutation;\s*ROLLBACK;\s*$/);
  });
});

describe("the live check", () => {
  it("asks about every public table for both roles and all three privileges", () => {
    expect(CHECK).toMatch(/relnamespace = 'public'::regnamespace/);
    expect(CHECK).toMatch(/has_table_privilege\(r\.role, c\.oid, p\.priv\)/);
    expect(CHECK).toMatch(/\["TRUNCATE", "TRIGGER", "REFERENCES"\]/);
    expect(CHECK).toMatch(/\["anon", "authenticated"\]/);
  });

  it("fails, rather than skipping, when it cannot ask", () => {
    expect(CHECK).not.toMatch(/not treating that as a failure/);
    expect(CHECK).toMatch(/SUPABASE_DB_URL is not set[\s\S]*?process\.exit\(1\)/);
    expect(CHECK).toMatch(/could not ask the database[\s\S]*?process\.exit\(1\)/);
  });

  it("is a step of the job that holds the database credential, gated like its neighbours", () => {
    const job = WORKFLOW.slice(WORKFLOW.indexOf("name: Migrations applied to the live database"));
    const at = job.indexOf("node scripts/check-public-table-grants.mjs");
    expect(at).toBeGreaterThan(0);
    const stepStart = job.lastIndexOf("- name:", at);
    const nextStep = job.indexOf("- name:", at);
    const step = job.slice(stepStart, nextStep);
    expect(step).toMatch(/SUPABASE_DB_URL: \$\{\{ secrets\.SUPABASE_DB_URL \}\}/);
    expect(step).toMatch(/continue-on-error: \$\{\{ github\.event_name == 'pull_request' \}\}/);
    expect(step).toMatch(/if: always\(\) && steps\.psql\.conclusion == 'success'/);
  });
});
