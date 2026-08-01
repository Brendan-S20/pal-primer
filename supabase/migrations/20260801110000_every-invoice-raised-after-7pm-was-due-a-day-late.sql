-- Every invoice raised after 7pm local was due a day late.
--
-- `tg_set_invoice_due_on` computed the due date like this:
--
--     new.due_on := coalesce(new.issued_at::date, current_date) + coalesce(_net, 15);
--
-- `issued_at` is a timestamptz and `::date` casts it in the SESSION's
-- timezone. This database's TimeZone is UTC; every organization in it is
-- America/Chicago. So from 19:00 local until midnight — five hours of every
-- day, 21% of the clock — the server thinks it is already tomorrow.
--
-- Proven live, rolled back, on an invoice issued 2026-08-01 02:00 UTC, which
-- is 2026-07-31 21:00 in Chicago:
--
--     db_utc_day=2026-08-01   org_local_day=2026-07-31
--     due_on WRITTEN=2026-08-16   SHOULD BE=2026-08-15   drift=1
--
-- ── WHY A DAY MATTERS HERE ────────────────────────────────────────────────
--
-- `due_on` is not decorative. It is the only input to overdue status, the
-- dunning ladder, the aging buckets on the CPA pack, and the reminder emails.
-- An invoice raised at 9pm is collected a day late, chased a day late, and
-- lands in the wrong column on the schedule an accountant hands to the IRS.
--
-- The nightly batch runs at 06:10 UTC — 01:10 Chicago — so invoices it
-- generates are inside the safe window and are correct today. Every invoice a
-- human raises in the evening is not. That is the worst shape for a bug like
-- this: it is invisible in the bulk data and only wrong for the ones somebody
-- typed by hand.
--
-- ── THE FIX ───────────────────────────────────────────────────────────────
--
-- Read the organization's timezone, which is already on the row, and take the
-- calendar day there. `coalesce(timezone, 'America/Chicago')` matches
-- DEFAULT_ORG_TIMEZONE in src/lib/org-day.ts — if those two ever disagree the
-- same invoice gets two different due dates depending on which layer computed
-- it, which is the failure this whole cluster is made of.
--
-- The `current_date` fallback for a NULL issued_at moves into the org's
-- timezone too. A draft invoice with no issue date is rare, and it would have
-- been wrong in exactly the same five-hour window.
--
-- ── NOT BACKFILLED, DELIBERATELY ─────────────────────────────────────────
--
-- Checked before deciding: of the 22 live invoices, `late_evening_issues = 0` —
-- none was issued inside the window, so none carries a wrong due date and
-- there is nothing to correct. Rewriting `due_on` on historical invoices would
-- move dates a customer may already have been quoted, to fix rows that are not
-- wrong. If any are ever found, that is a deliberate data correction with the
-- owner, not a side effect of a schema migration.

CREATE OR REPLACE FUNCTION public.tg_set_invoice_due_on()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  _net integer;
  _tz  text;
begin
  if new.due_on is null then
    select coalesce(o.invoice_net_days, 15), coalesce(o.timezone, 'America/Chicago')
      into _net, _tz
      from public.organizations o where o.id = new.organization_id;

    -- The calendar day in the ORGANIZATION's timezone, not the database
    -- session's. `::date` on a timestamptz silently uses the latter.
    new.due_on := coalesce(
      (new.issued_at AT TIME ZONE coalesce(_tz, 'America/Chicago'))::date,
      (now() AT TIME ZONE coalesce(_tz, 'America/Chicago'))::date
    ) + coalesce(_net, 15);
  end if;
  return new;
end;
$function$;

DO $$
DECLARE _src text; _late int;
BEGIN
  SELECT prosrc INTO _src FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'tg_set_invoice_due_on';

  -- The defect was a bare ::date on a timestamptz. If one comes back, so does
  -- the bug, silently and only in the evening.
  IF _src ~ 'issued_at::date' OR _src ~ 'coalesce\(new\.issued_at::date' THEN
    RAISE EXCEPTION 'the due date is being taken in the session timezone again';
  END IF;
  IF _src !~ 'AT TIME ZONE' THEN
    RAISE EXCEPTION 'the due date is not being taken in the org timezone';
  END IF;

  -- The trigger has to be attached, or the correct body runs never. A function
  -- with no CREATE TRIGGER reads exactly like a working guard.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE c.relname = 'invoices' AND NOT t.tgisinternal
       AND p.proname = 'tg_set_invoice_due_on'
  ) THEN
    RAISE EXCEPTION 'tg_set_invoice_due_on is not attached to invoices';
  END IF;

  -- Recorded rather than assumed: the claim above that nothing needs
  -- backfilling is only true while this is zero.
  SELECT count(*) INTO _late FROM public.invoices i
    JOIN public.organizations o ON o.id = i.organization_id
   WHERE i.issued_at IS NOT NULL
     AND (i.issued_at AT TIME ZONE 'UTC')::date
         IS DISTINCT FROM (i.issued_at AT TIME ZONE coalesce(o.timezone,'America/Chicago'))::date;
  RAISE NOTICE 'invoices issued inside the disagreement window: %', _late;
END $$;
