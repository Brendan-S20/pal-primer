-- Signed-in users cannot empty the portal change tables.
--
-- Supabase's default privileges left `authenticated` holding TRUNCATE,
-- REFERENCES and TRIGGER on these three tables. RLS does not apply to
-- TRUNCATE, so any signed-in user could empty them outright, every tenant's
-- rows at once. Migration 20261108153700 only revoked INSERT, UPDATE and
-- DELETE, leaving SELECT (which RLS scopes) and these three behind.
--
-- Already applied to production, approved by Brendan, and recorded in its
-- migration ledger as version 20261109030541; this file is that statement,
-- verbatim. Proof: supabase/proofs/20261109030541-signed-in-users-cannot-empty-the-portal-change-tables.sql

revoke truncate, references, trigger on table public.portal_change_rules, public.portal_change_requests, public.portal_change_fee_charges from authenticated;
