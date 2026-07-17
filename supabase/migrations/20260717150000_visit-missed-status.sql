-- QA round 3, finding B6 (visit lifecycle): add a terminal "missed" status.
-- Past visits that were never serviced were stuck in 'scheduled' forever (the
-- platform Health page counts them as "stuck visits"). 'missed' is distinct
-- from 'skipped' (a deliberate no-service decision that can carry a skip
-- charge) and 'canceled' (called off): a missed visit simply had its date pass
-- with no service recorded. It is NOT billable (billing keys on 'completed' and
-- billable 'skipped' only), matching how the app already treats non-completed
-- visits (I6 — no retroactive billing).
ALTER TYPE public.visit_status ADD VALUE IF NOT EXISTS 'missed';
