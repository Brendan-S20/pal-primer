-- A client's credit balance and the ledger behind it disagreed, and the
-- product spends the balance.
--
-- ── THE DRIFT IS LIVE, NOT HYPOTHETICAL ────────────────────────────────────
--
--     Emily Rodriguez   cached -18000   ledger -30000   drift +12000
--     Chris Williams    cached  -6000   ledger -15000   drift  +9000
--     Kevin O'Brien     cached   2000   ledger   2000   drift      0
--
-- $120.00 and $90.00 of balance that the ledger does not support. `clients
-- .credit_balance_cents` is what apply_credit_to_invoice spends and what the
-- customer's portal shows; `credit_ledger` is the audit trail printed next to
-- it on the same screen. They are two answers to one question.
--
-- ── WHY THEY DRIFT ─────────────────────────────────────────────────────────
--
-- Five routines write the ledger. Two of them maintained the balance and three
-- did not:
--
--     create_addon_charge              INSERT INTO credit_ledger, no balance
--     generate_addon_charges_through   INSERT INTO credit_ledger, no balance
--     void_addon_charge                INSERT INTO credit_ledger, no balance
--     post_credit_entry                both
--     portal_redeem_promo              both
--
-- So on a PREPAID client every add-on debits the ledger and leaves the balance
-- untouched — while the charge is stamped `paid_from_credit`, meaning the app
-- believes it has been collected. The same dollars are then spent a second
-- time by apply_credit_to_invoice, which reads the cached balance. On a $500
-- top-up, a $45 add-on and a $400 invoice, $445 comes out of $500 twice over.
--
-- ── THE FIX IS THE PATTERN THAT ALREADY WORKS HERE ────────────────────────
--
-- Not "add the missing UPDATE to three more functions" — that is the same
-- duplication that produced the bug, and the next writer will forget too.
--
-- `refresh_active_client_count` and `refresh_active_seat_count` are maintained
-- by row triggers that RECOUNT FROM SCRATCH rather than incrementing, and both
-- were audited at exactly zero drift across every organization. That is not
-- luck; it is why they cannot drift. The credit balance now works the same way:
-- a trigger on credit_ledger sets the balance to the ledger's sum, on insert,
-- update and delete. Any writer, present or future, is covered without knowing
-- it exists.
--
-- The two manual updates are removed, or they would double-count on top of the
-- trigger.
--
-- ── AND ONE THING FOUND WHILE READING IT ──────────────────────────────────
--
-- portal_redeem_promo inserts `kind = 'promo'`, and the credit_ledger check
-- constraint has never allowed that value:
--
--     kind = ANY (ARRAY['prepayment','visit_debit','refund','adjustment',
--                       'referral_reward','referral_bonus','addon_debit',
--                       'invoice_application'])
--
-- Proven: `kind=promo REJECTED by the check constraint`. So EVERY promo code
-- redeemed from the client portal has thrown, for as long as the feature has
-- existed. The dedupe guard inside it also reads `kind = 'promo'`, so the value
-- is load-bearing rather than a typo to swap out — 'promo' is added to the
-- constraint instead.
--
-- ── BACKFILL ───────────────────────────────────────────────────────────────
--
-- Every balance is set to its ledger sum. Safe to do because the ledger is
-- complete: `clients_with_balance_but_no_ledger = 0`, so no balance predates
-- the ledger and nothing is being erased. Where they disagree the ledger is the
-- record — it has one row per event with a reason attached, and the cached
-- figure has none.

-- ── 1. the kind that could never be written ───────────────────────────────
ALTER TABLE public.credit_ledger DROP CONSTRAINT IF EXISTS credit_ledger_kind_check;
ALTER TABLE public.credit_ledger ADD CONSTRAINT credit_ledger_kind_check
  CHECK (kind = ANY (ARRAY[
    'prepayment', 'visit_debit', 'refund', 'adjustment',
    'referral_reward', 'referral_bonus', 'addon_debit',
    'invoice_application', 'promo'
  ]));

-- ── 2. one writer for the balance, and it is not a function ───────────────
CREATE OR REPLACE FUNCTION public.tg_credit_ledger_maintain_balance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _client uuid;
BEGIN
  -- On an UPDATE that moved the row between clients, both sides need recounting.
  FOR _client IN
    SELECT DISTINCT x FROM unnest(ARRAY[
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.client_id END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.client_id END
    ]) AS x WHERE x IS NOT NULL
  LOOP
    -- Recount, never increment. An increment is a second implementation of the
    -- balance and can be skipped, double-applied, or applied to the wrong row.
    UPDATE public.clients c
       SET credit_balance_cents = COALESCE(
             (SELECT sum(cl.delta_cents) FROM public.credit_ledger cl
               WHERE cl.client_id = _client), 0),
           updated_at = now()
     WHERE c.id = _client;
  END LOOP;
  RETURN NULL;
END;
$function$;

DROP TRIGGER IF EXISTS credit_ledger_maintain_balance ON public.credit_ledger;
CREATE TRIGGER credit_ledger_maintain_balance
  AFTER INSERT OR UPDATE OR DELETE ON public.credit_ledger
  FOR EACH ROW EXECUTE FUNCTION public.tg_credit_ledger_maintain_balance();

-- ── 3. the two manual updates come out ────────────────────────────────────
CREATE OR REPLACE FUNCTION public.post_credit_entry(
  _org_id uuid, _client_id uuid, _delta integer, _kind text,
  _invoice_id uuid, _visit_id uuid, _note text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF auth.uid() IS NOT NULL THEN
    IF NOT public.is_org_member(auth.uid(), _org_id) THEN
      RAISE EXCEPTION 'Not authorized for this organization.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    -- Membership alone still lets a member of one tenant name their own org id
    -- and another tenant's client id; the balance write is keyed on the client.
    IF NOT EXISTS (
      SELECT 1 FROM public.clients c
       WHERE c.id = _client_id AND c.organization_id = _org_id
    ) THEN
      RAISE EXCEPTION 'Client does not belong to this organization.'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;

  INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, invoice_id, visit_id, note)
  VALUES (_org_id, _client_id, _delta, _kind, _invoice_id, _visit_id, _note);
  -- The balance is maintained by credit_ledger_maintain_balance. Updating it
  -- here as well would double every entry posted through this function.
END;
$function$;

CREATE OR REPLACE FUNCTION public.portal_redeem_promo(_token uuid, _code text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _cid uuid; _org uuid; _p record; _amount integer;
BEGIN
  SELECT c.id, c.organization_id INTO _cid, _org
    FROM public.clients c WHERE c.portal_token = _token AND c.active = true;
  IF _cid IS NULL THEN RAISE EXCEPTION 'Invalid portal token'; END IF;
  SELECT * INTO _p FROM public.promo_codes
   WHERE organization_id = _org AND upper(code) = upper(trim(_code)) AND active = true;
  IF _p.id IS NULL THEN RAISE EXCEPTION 'Code not found or inactive'; END IF;
  IF _p.expires_at IS NOT NULL AND _p.expires_at < now() THEN
    RAISE EXCEPTION 'Code has expired'; END IF;
  IF _p.max_redemptions IS NOT NULL AND _p.redemption_count >= _p.max_redemptions THEN
    RAISE EXCEPTION 'Code has reached its redemption limit'; END IF;
  IF EXISTS (SELECT 1 FROM public.credit_ledger
     WHERE client_id = _cid AND kind = 'promo' AND note = 'Promo: '||upper(_p.code)) THEN
    RAISE EXCEPTION 'You have already used this code'; END IF;
  IF _p.discount_type = 'amount' THEN
    _amount := COALESCE(_p.discount_value_cents, 0);
  ELSE
    RAISE EXCEPTION 'Percent codes are applied automatically to your next invoice';
  END IF;
  IF _amount <= 0 THEN RAISE EXCEPTION 'Code has no value'; END IF;
  INSERT INTO public.credit_ledger(organization_id, client_id, delta_cents, kind, note)
  VALUES (_org, _cid, _amount, 'promo', 'Promo: '||upper(_p.code));
  -- balance maintained by the trigger; see post_credit_entry.
  UPDATE public.promo_codes SET redemption_count = redemption_count + 1 WHERE id = _p.id;
  RETURN _amount;
END;
$function$;

-- ── 4. backfill ───────────────────────────────────────────────────────────
UPDATE public.clients c
   SET credit_balance_cents = COALESCE(
         (SELECT sum(cl.delta_cents) FROM public.credit_ledger cl WHERE cl.client_id = c.id), 0)
 WHERE c.credit_balance_cents IS DISTINCT FROM COALESCE(
         (SELECT sum(cl.delta_cents) FROM public.credit_ledger cl WHERE cl.client_id = c.id), 0);

DO $$
DECLARE _drift int; _n int;
BEGIN
  SELECT count(*) INTO _drift FROM public.clients c
   WHERE c.credit_balance_cents IS DISTINCT FROM COALESCE(
           (SELECT sum(cl.delta_cents) FROM public.credit_ledger cl WHERE cl.client_id = c.id), 0);
  IF _drift <> 0 THEN
    RAISE EXCEPTION '% client(s) still disagree with their ledger after the backfill', _drift;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
                  WHERE c.relname = 'credit_ledger' AND NOT t.tgisinternal
                    AND t.tgname = 'credit_ledger_maintain_balance') THEN
    RAISE EXCEPTION 'the balance trigger is not attached';
  END IF;

  -- No routine may still hand-maintain the balance, or it double-counts.
  --
  -- ── WHY prosrc AND NOT pg_get_functiondef ──────────────────────────────
  --
  -- This read `pg_get_functiondef(p.oid)`, and that is the seventh fault the
  -- Sandboxes replay found:
  --
  --     ERROR: "array_agg" is an aggregate function (SQLSTATE 42809)
  --
  -- `pg_get_functiondef` raises on any pg_proc row that is not a plain
  -- function or procedure — an aggregate or a window function has no CREATE
  -- statement to reconstruct. This is the only one of the 36 pg_get_functiondef
  -- call sites in these migrations that scans an UNBOUNDED set of rows: every
  -- other one names its function, by `proname =` or by `::regprocedure`. Here
  -- the only filter on the name is `<>`, which excludes exactly one row and
  -- leaves the rest of the schema in scope.
  --
  -- Production has 191 routines in `public` and every one is prokind 'f', so
  -- the scan never met a row it could not describe and this migration applied
  -- cleanly. A database built from these files has an aggregate in `public`
  -- that production does not, and the count query dies before the check it
  -- was written to perform. Seventh fault, same family as the other six:
  -- the files describe a schema the live database happens to satisfy.
  --
  -- `p.prosrc` is the fix rather than a `prokind` filter, because a prokind
  -- filter in the same WHERE clause does not actually prevent this. Postgres
  -- does not promise to evaluate AND terms left to right, so the planner may
  -- still call pg_get_functiondef on the row the filter was meant to exclude.
  -- prosrc cannot raise for any prokind, needs no guard to be ordered
  -- correctly, and is the function BODY — which is where
  -- `credit_balance_cents = credit_balance_cents` was always being looked for.
  -- The header that pg_get_functiondef adds never mattered to this pattern.
  SELECT count(*) INTO _n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname <> 'tg_credit_ledger_maintain_balance'
     AND p.prosrc ~* 'credit_balance_cents = credit_balance_cents';
  IF _n <> 0 THEN
    RAISE EXCEPTION '% routine(s) still increment the balance by hand', _n;
  END IF;
END $$;
