-- Proof for 20261029150000: a service says how it starts online (#574).
--
-- A business that walks, sits and trains. Every row below is inserted with
-- NO public_booking_mode, the way Settings, the line seed and seed_demo_org
-- insert today.
--
--   1. The insert trigger answers for each: a training evaluation is
--      one_time, a walk is recurring, a per-night stay is request_only. The
--      names are ordinary on purpose; nothing reads them.
--   2. An owner's explicit answer is kept, on insert and on update.
--   3. A package service must sell one of its OWN packages: another
--      service's package is refused, its own is accepted.
--   4. The backfill touches only NULL rows: a row set to recurring by hand
--      stays recurring when the migration's UPDATEs run again.
--   5. Mutation: drop the trigger and insert a training service. It lands
--      NULL, which the app reads as request only. If it does not, the
--      trigger is not what decides: INCONCLUSIVE. Restored afterwards.
--
-- One transaction, ends in ROLLBACK. Run against a freshly reset local
-- database:
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261029150000-a-service-says-how-it-starts-online.sql

\set ON_ERROR_STOP on
\o /dev/null
BEGIN;

DO $$
DECLARE
  _org uuid; _eval uuid; _walk uuid; _stay uuid; _lesson uuid; _pkg uuid; _other_pkg uuid;
  _set uuid; _m text; _refused boolean;
BEGIN
  PERFORM set_config('app.allow_protected_org_write', '1', true);
  INSERT INTO public.organizations (name, slug, service_lines, timezone, currency)
  VALUES ('Start Mode Proof', 'start-mode-proof',
          ARRAY['dog_walking', 'pet_sitting', 'training'], 'UTC', 'usd')
  RETURNING id INTO _org;
  PERFORM set_config('app.allow_protected_org_write', '', true);

  -- ── 1. Defaults by line, never by name ──────────────────────────────────
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, active)
  VALUES (_org, 'Proof assessment', 'training', 'visit', 45, 7500, true)
  RETURNING id INTO _eval;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, active)
  VALUES (_org, 'Proof walk', 'dog_walking', 'visit', 30, 2500, true)
  RETURNING id INTO _walk;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, active)
  VALUES (_org, 'Proof stay', 'pet_sitting', 'night', NULL, 6000, true)
  RETURNING id INTO _stay;

  SELECT public_booking_mode INTO _m FROM public.services WHERE id = _eval;
  IF _m IS DISTINCT FROM 'one_time' THEN
    RAISE EXCEPTION 'PROOF FAILED [1]: a training service started as %, not one_time', _m;
  END IF;
  SELECT public_booking_mode INTO _m FROM public.services WHERE id = _walk;
  IF _m IS DISTINCT FROM 'recurring' THEN
    RAISE EXCEPTION 'PROOF FAILED [1]: a walk started as %, not recurring', _m;
  END IF;
  SELECT public_booking_mode INTO _m FROM public.services WHERE id = _stay;
  IF _m IS DISTINCT FROM 'request_only' THEN
    RAISE EXCEPTION 'PROOF FAILED [1]: a stay started as %, not request_only', _m;
  END IF;

  -- ── 2. The owner's answer is kept ───────────────────────────────────────
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, active, public_booking_mode)
  VALUES (_org, 'Proof weekly lessons', 'training', 'visit', 60, 9000, true, 'recurring')
  RETURNING id INTO _set;
  SELECT public_booking_mode INTO _m FROM public.services WHERE id = _set;
  IF _m IS DISTINCT FROM 'recurring' THEN
    RAISE EXCEPTION 'PROOF FAILED [2]: an explicit recurring was overwritten with %', _m;
  END IF;
  UPDATE public.services SET public_booking_mode = 'recurring' WHERE id = _eval;
  SELECT public_booking_mode INTO _m FROM public.services WHERE id = _eval;
  IF _m IS DISTINCT FROM 'recurring' THEN
    RAISE EXCEPTION 'PROOF FAILED [2]: flipping to recurring did not hold (%)', _m;
  END IF;
  UPDATE public.services SET public_booking_mode = 'one_time' WHERE id = _eval;

  -- ── 3. A package is the service's own ───────────────────────────────────
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, active)
  VALUES (_org, 'Proof private lesson', 'training', 'visit', 60, 9000, true)
  RETURNING id INTO _lesson;
  INSERT INTO public.service_packages (organization_id, service_id, name, sessions_count, price_cents, active)
  VALUES (_org, _lesson, 'Proof 4-pack', 4, 32000, true) RETURNING id INTO _pkg;
  INSERT INTO public.service_packages (organization_id, service_id, name, sessions_count, price_cents, active)
  VALUES (_org, _eval, 'Proof other pack', 2, 14000, true) RETURNING id INTO _other_pkg;

  _refused := false;
  BEGIN
    UPDATE public.services SET public_booking_mode = 'package', public_package_id = _other_pkg
     WHERE id = _lesson;
  EXCEPTION WHEN check_violation THEN _refused := true;
  END;
  IF NOT _refused THEN
    RAISE EXCEPTION 'PROOF FAILED [3]: a service sold another service''s package';
  END IF;
  UPDATE public.services SET public_booking_mode = 'package', public_package_id = _pkg
   WHERE id = _lesson;
  SELECT public_booking_mode INTO _m FROM public.services WHERE id = _lesson;
  IF _m IS DISTINCT FROM 'package' THEN
    RAISE EXCEPTION 'PROOF FAILED [3]: its own package was not accepted (%)', _m;
  END IF;

  -- ── 4. The backfill only fills NULLs ────────────────────────────────────
  UPDATE public.services SET public_booking_mode = 'one_time'
   WHERE public_booking_mode IS NULL AND service_line = 'training';
  SELECT public_booking_mode INTO _m FROM public.services WHERE id = _set;
  IF _m IS DISTINCT FROM 'recurring' THEN
    RAISE EXCEPTION 'PROOF FAILED [4]: the backfill overwrote an owner''s recurring with %', _m;
  END IF;

  -- ── 5. Mutation: without the trigger, a training row is unset ───────────
  ALTER TABLE public.services DISABLE TRIGGER services_public_booking_mode;
  INSERT INTO public.services (organization_id, name, service_line, price_unit,
                               default_duration_min, base_price_cents, active)
  VALUES (_org, 'Proof unset', 'training', 'visit', 45, 7500, true)
  RETURNING public_booking_mode INTO _m;
  ALTER TABLE public.services ENABLE TRIGGER services_public_booking_mode;
  IF _m IS NOT NULL THEN
    RAISE EXCEPTION 'PROOF INCONCLUSIVE [5]: with the trigger off a training row still got %', _m;
  END IF;

  RAISE NOTICE 'PROOF PASSED: defaults by line, owner answers kept, own package only, backfill fills NULLs, trigger is what decides';
END $$;

\o
ROLLBACK;
