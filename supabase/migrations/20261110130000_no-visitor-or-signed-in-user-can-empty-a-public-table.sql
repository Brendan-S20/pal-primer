-- No visitor or signed-in user can empty a public table (#842).
--
-- Supabase's default privileges hand `anon` and `authenticated` ALL on every
-- table `postgres` creates in public: SELECT, INSERT, UPDATE and DELETE, which
-- RLS scopes, and TRUNCATE, TRIGGER and REFERENCES, which it does not. RLS
-- has no TRUNCATE policy, so any holder of TRUNCATE can empty a table outright,
-- every tenant's rows at once. 20261109030541 closed this on the three
-- portal_change_* tables; after #760, directory_profiles and
-- directory_profile_services still had it, and a census of production
-- (information_schema.role_table_grants, 2026-11-10, after #760) found 106
-- public tables, 575 grant rows, in the same state.
--
-- This revokes exactly those three privileges from both roles on all 106.
-- SELECT, INSERT, UPDATE and DELETE, RLS and every policy are untouched. A
-- REVOKE of a privilege a role does not hold is a no-op, so the three groups
-- the census found (both roles; authenticated only; time_entries, where
-- authenticated had REFERENCES and TRIGGER only) are one statement.
--
-- The other 37 public base tables already lack all three for both roles,
-- each through a REVOKE ALL in the migration that created it (the
-- portal_change_* tables through 20261109030541, directory_reviews through
-- 20261110120100). They are not named here: nothing is granted back to them.
--
-- Proof: supabase/proofs/20261110130000-no-visitor-or-signed-in-user-can-empty-a-public-table.sql
-- Live check: scripts/check-public-table-grants.mjs, in ci.yml's "Migrations
-- applied to the live database" job.

-- Both anon and authenticated held TRUNCATE, TRIGGER and REFERENCES (86).
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE
  public.account_deletion_schedule,
  public.activity_log,
  public.addon_charges,
  public.addon_requests,
  public.addon_services,
  public.addon_subscriptions,
  public.ai_receptionist_logs,
  public.app_notification_prefs,
  public.app_notifications,
  public.blackout_dates,
  public.client_holds,
  public.client_notes,
  public.clients,
  public.credit_ledger,
  public.dna_matches,
  public.dogs,
  public.email_send_log,
  public.email_send_state,
  public.email_unsubscribe_tokens,
  public.email_verifications,
  public.founding_accounts,
  public.franchise_adjustments,
  public.franchise_link_codes,
  public.franchise_royalty_invoices,
  public.gift_card_redemptions,
  public.gift_cards,
  public.impersonation_grants,
  public.import_batches,
  public.import_rows,
  public.inventory_assignments,
  public.inventory_items,
  public.inventory_movements,
  public.invoice_line_items,
  public.invoices,
  public.leads,
  public.locations,
  public.messages,
  public.neighbor_leads,
  public.org_invites,
  public.org_platform_addons,
  public.org_texting_registrations,
  public.org_twilio_credentials,
  public.organizations,
  public.payments,
  public.platform_addons,
  public.platform_admin_audit,
  public.platform_admins,
  public.platform_announcement_reads,
  public.platform_announcements,
  public.platform_coupons,
  public.platform_feature_flags,
  public.platform_invites,
  public.platform_invoices,
  public.platform_org_feature_flags,
  public.platform_plans,
  public.platform_referral_settings,
  public.platform_signup_requests,
  public.platform_stripe_events,
  public.platform_support_notes,
  public.portal_code_attempts,
  public.portal_otps,
  public.portal_sessions,
  public.promo_codes,
  public.properties,
  public.property_units,
  public.push_subscriptions,
  public.qc_tickets,
  public.road_legs,
  public.roadmap_vote_throttle,
  public.roadmap_votes,
  public.signup_requests,
  public.skip_billing_rules,
  public.sms_consent_records,
  public.staff,
  public.station_service_logs,
  public.subscriptions,
  public.suppressed_emails,
  public.tenant_referrals,
  public.unit_incidents,
  public.user_roles,
  public.visit_photos,
  public.visits,
  public.waste_disposal_facilities,
  public.waste_disposal_manifests,
  public.waste_stations,
  public.zones
FROM anon, authenticated;

-- Only authenticated held TRUNCATE, TRIGGER and REFERENCES (19).
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE
  public.ai_usage_events,
  public.ai_usage_periods,
  public.client_packages,
  public.directory_profile_services,
  public.directory_profiles,
  public.expenses,
  public.holiday_dates,
  public.homework,
  public.pet_care_instructions,
  public.pet_vaccinations,
  public.review_items,
  public.service_packages,
  public.session_progress,
  public.staff_time_off,
  public.stays,
  public.training_session_notes,
  public.training_skills,
  public.walk_groups,
  public.weather_forecast_cache
FROM anon, authenticated;

-- Only authenticated held REFERENCES and TRIGGER (1). All three, both roles.
REVOKE TRUNCATE, TRIGGER, REFERENCES ON TABLE
  public.time_entries
FROM anon, authenticated;

-- What this file establishes, asserted from any starting state: no public
-- base table, the 106 above or the 37 already clean, lets anon or
-- authenticated TRUNCATE, TRIGGER or REFERENCES it, directly, through PUBLIC
-- or through a role either belongs to. A table created after the census that
-- carries the default grants fails this by name rather than being missed.
DO $verify$
DECLARE
  _held text[];
BEGIN
  SELECT array_agg(format('%s holds %s on public.%I', r.role, p.priv, c.relname)
                   ORDER BY c.relname, r.role, p.priv)
    INTO _held
    FROM pg_class c
    CROSS JOIN (VALUES ('anon'), ('authenticated')) AS r(role)
    CROSS JOIN (VALUES ('TRUNCATE'), ('TRIGGER'), ('REFERENCES')) AS p(priv)
   WHERE c.relnamespace = 'public'::regnamespace
     AND c.relkind IN ('r', 'p')
     AND has_table_privilege(r.role, c.oid, p.priv);
  IF _held IS NOT NULL THEN
    RAISE EXCEPTION E'public tables still grant TRUNCATE/TRIGGER/REFERENCES to a client role:\n  %',
      array_to_string(_held, E'\n  ');
  END IF;
END
$verify$;
