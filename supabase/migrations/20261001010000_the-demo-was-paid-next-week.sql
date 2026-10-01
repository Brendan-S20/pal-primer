-- The demo was paid next week.
--
-- seed_demo_org dates its history from calendar days plus a fixed number of
-- hours: an invoice for a closed period is issued at period_end + 1, 09:00,
-- and paid at period_end + 4, 14:00. Late in a month those are long past.
-- In the first four days of a month they are not: on 1 October, September's
-- invoices were PAID ON 4 OCTOBER, and the current period's invoice was
-- ISSUED IN NOVEMBER.
--
-- Found by CI on 2026-10-01. The accountant-CSV E2E counts payments in
-- Postgres from 1 January with no upper bound, and the income report counts
-- payments up to today, so the payment dated three days ahead was in one and
-- not the other: 27 against 26, on main and on every open pull request.
-- The same dates are the "two seeded invoices are dated tomorrow" that the
-- 27 September review gave as the likely reason the dashboard's receivables
-- ($830) disagreed with Reports' ($438) on demo data.
--
-- Every seeded timestamp is now at most now(). A closed-period invoice is
-- paid only if its payment day has already happened; one whose period just
-- ended stays open, which is what a real business has on the 2nd of the
-- month. The one invoice that settles inside the current month is paid no
-- earlier than it was issued.
--
-- Spliced by name against the body 20260930010000 left, raising if it is not
-- that body.

DO $splice$
DECLARE
  _def text;
  _new text;
  _topup constant text :=
    '(CASE WHEN m = 3 THEN mtd_day ELSE today - (70 - m * 21) END)::timestamptz + interval ''9 hours''';
BEGIN
  _def := pg_get_functiondef('public.seed_demo_org(uuid)'::regprocedure);
  IF strpos(_def, 'AND (i.period_end + 4)::timestamptz + interval ''14 hours'' <= now()') > 0 THEN
    RETURN;  -- already spliced
  END IF;

  -- Prepaid top-ups: five timestamps from the same expression.
  _new := replace(_def, _topup, 'LEAST(' || _topup || ', now())');
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer dates its prepaid top-ups the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  -- Issued, created and sent: never after now.
  _new := replace(_def,
    E'     SET issued_at  = (period_end + 1)::timestamptz + interval ''9 hours'',\n'
    || E'         created_at = (period_end + 1)::timestamptz + interval ''9 hours'',\n'
    || E'         due_on     = period_end + 15,\n'
    || E'         sent_at    = (period_end + 1)::timestamptz + interval ''9 hours'',',
    E'     SET issued_at  = LEAST((period_end + 1)::timestamptz + interval ''9 hours'', now()),\n'
    || E'         created_at = LEAST((period_end + 1)::timestamptz + interval ''9 hours'', now()),\n'
    || E'         due_on     = period_end + 15,\n'
    || E'         sent_at    = LEAST((period_end + 1)::timestamptz + interval ''9 hours'', now()),');
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer issues its invoices the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  -- Paid only once the payment day has happened.
  _new := replace(_def,
    E'   WHERE i.id = r.id AND r.rn % 7 <> 3;',
    E'   WHERE i.id = r.id AND r.rn % 7 <> 3\n'
    || E'     AND (i.period_end + 4)::timestamptz + interval ''14 hours'' <= now();');
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer pays its closed periods the way this splice expects; re-cut it against the current body.';
  END IF;
  _def := _new;

  -- The month-to-date settlement: not before it was issued, not after now.
  _new := replace(_def,
    E'         paid_at = mtd_day::timestamptz + interval ''11 hours''',
    E'         paid_at = LEAST(GREATEST(mtd_day::timestamptz + interval ''11 hours'', issued_at), now())');
  IF _new = _def THEN
    RAISE EXCEPTION 'seed_demo_org no longer settles its month-to-date invoice the way this splice expects; re-cut it against the current body.';
  END IF;

  EXECUTE _new;
END
$splice$;

REVOKE ALL ON FUNCTION public.seed_demo_org(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.seed_demo_org(uuid) TO authenticated, service_role;

DO $check$
DECLARE
  _seed text;
BEGIN
  SELECT prosrc INTO _seed FROM pg_proc WHERE oid = 'public.seed_demo_org(uuid)'::regprocedure;
  IF _seed !~ 'AND \(i\.period_end \+ 4\)::timestamptz \+ interval ''14 hours'' <= now\(\)' THEN
    RAISE EXCEPTION 'seed_demo_org still pays invoices on days that have not happened';
  END IF;
  IF _seed ~ '(?<!LEAST\()\(period_end \+ 1\)::timestamptz \+ interval ''9 hours'',' THEN
    RAISE EXCEPTION 'seed_demo_org still issues invoices in the future';
  END IF;
  IF has_function_privilege('anon', 'public.seed_demo_org(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can reseed an organization';
  END IF;
END
$check$;
