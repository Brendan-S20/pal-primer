-- Four ways a franchise settlement statement was wrong.
--
-- The seven settlement-math claims left unprobed by v1.12, worked through one
-- at a time against the live database. Four reproduce, three do not. Every
-- number below came out of a transaction that rolled itself back.
--
-- ── 1. VOIDING A STATEMENT STRANDED ITS ADJUSTMENTS FOREVER ────────────────
--
-- `consume` marks a swept adjustment `applied` and links it to the statement.
-- The `adj` CTE only reconsiders an applied adjustment when its statement is
-- still a DRAFT for the period being settled. A voided statement is neither, so
-- its adjustments were counted on nothing, ever again:
--
--     JULY: rev=100000 royalty=10000 adj=20000 net=70000 | adj status=applied
--     AFTER VOID: aug_adj=0 | july_status=void | adj_now=applied linked_void=true
--
-- A $200 chargeback the location owed simply ceased to exist. Voiding is the
-- one action whose whole purpose is "undo this statement", and it undid
-- everything except the part that moves money.
--
-- Fixed with a trigger rather than in the void call site, because the call site
-- is not the boundary — `franchise_royalty_invoices` takes UPDATEs directly
-- from anyone holding manage_franchise. Reversed adjustments are left alone;
-- they are settled history, not outstanding work.
--
-- ── 2. A REVERSED DEDUCTION STAYED ON THE DRAFT IT WAS APPLIED TO ─────────
--
-- Winning a chargeback whose statement is still a draft marks the deduction
-- `reversed` and returns — correctly, since a draft has not been sent, so there
-- is nothing to repay. But the draft ROW keeps the numbers it was generated
-- with:
--
--     draft after settle:   adj=20000 net=70000
--     after winning:        adj_now=reversed
--     DRAFT STILL SAYS:     adj=20000 net=70000 status=draft
--     after regenerating:   adj=0     net=90000
--
-- Regenerating fixes it. Nothing requires anyone to regenerate. Generate on the
-- 1st, win the dispute on the 5th, issue on the 10th, and the location is
-- billed $200 for a chargeback it won.
--
-- Fixed by refusing to issue a statement that disagrees with the adjustments
-- underneath it, rather than by silently recomputing on the way out. The
-- numbers on a statement should change only when someone regenerates it; what
-- must not happen is sending one that is known to be stale. The check is an
-- EXISTS over exactly the condition that makes it stale.
--
-- ── 3. AN ADJUSTMENT LANDED ON WHICHEVER STATEMENT WAS CUT FIRST ──────────
--
-- The `adj` CTE filtered on `status = 'pending'` and nothing else — no period
-- at all. So a chargeback on a July payment went onto an August statement if
-- August happened to be settled first, and July's own statement showed none:
--
--     C5) aug_adj=20000  july_adj=0   (the July chargeback landed on AUGUST)
--
-- The nightly cron settles last month, so the natural order usually hides it.
-- Re-running an old period, or backfilling after onboarding a location, does
-- not. A settlement statement is the document a franchisee reconciles their own
-- books against; one that omits a July chargeback and one that carries a
-- deduction with no event behind it are both unreconcilable.
--
-- Fixed by sweeping only adjustments filed before the period ends.
--
-- Precisely what that does and does not guarantee, because the probe after the
-- fix shows both:
--
--   GUARANTEED — a statement never carries an event that happened after its
--   period closed. An August chargeback can no longer appear on a July
--   statement. That is the property that makes a statement reconcilable
--   against the franchisee's own books for that month, and it did not hold.
--
--   NOT CHANGED — settling August before July still puts July's outstanding
--   chargeback on the August statement (`aug_first: aug_adj=50000`), because
--   at that moment it genuinely is outstanding and August is the first
--   statement being cut. That is carry-forward, and it is correct. Settled in
--   the normal order the periods separate cleanly: `july_adj=20000
--   aug_adj=30000`.
--
-- An adjustment filed in September against a July payment therefore lands on
-- September — that is when it became known, and it is the only period whose
-- statement has not already been sent.
--
-- `consume` gets the same filter. Without it, an adjustment outside the window
-- would be marked applied while being counted by nothing, which is defect 1
-- again by another route.
--
-- ── 4. CHANGING A ROYALTY RATE RESTATED CLOSED PERIODS ────────────────────
--
-- `kids` read `franchise_royalty_percent` live, so regenerating any draft
-- applied today's rate to a month that had already ended:
--
--     C8) july_royalty_at_10pct=10000 -> after_rate_change=25000 pct_on_row=25.00
--
-- Issued statements were already safe (`WHERE status = 'draft'` on the upsert).
-- Drafts were not, and a draft is exactly what is sitting there in the days
-- between generating and issuing. The payment-routing screen promises "a
-- statement you have already sent cannot change underneath you" — true, and the
-- one before it could.
--
-- There is no rate-history table, so the best available answer is: the rate a
-- period is settled at is the rate it was FIRST settled at. A period never
-- generated before still picks up the current rate.
--
-- ── THREE CLAIMS THAT DID NOT REPRODUCE ───────────────────────────────────
--
-- Recorded because a dismissed claim is worth as much as a confirmed one, and
-- because each was dismissed on evidence rather than on reading.
--
--   * "Royalty is charged on refunded gross." It is — and it is intended, and
--     the product says so in the money terms the owner is actually deciding:
--     "On a $100 refund they lose the full $100 and still owe you the royalty."
--     Measured all three responsibility modes; each matches its own explainer
--     exactly. Not a defect. The setting is named "Refunds & chargebacks"
--     throughout, so the refund/chargeback conflation I expected to find is
--     not a conflation.
--
--   * "Cross-period double-billing." Does not happen: an adjustment consumed
--     into July was not counted again in August (`july_adj=5000 aug_adj=0`). A
--     genuine race remains possible between two SIMULTANEOUS generate calls,
--     which is not claimed here because it was not demonstrated.
--
--   * "Rounding drift." `round(total * pct / 100.0)` runs once on the period
--     total, so nothing accumulates: three payments of 3333 at 7.5% give 750
--     whether rounded per payment or per period. Half a cent, once, per
--     statement.
--
-- Also checked and correct: `period_end` is EXCLUSIVE and every caller agrees
-- (`lastMonthRange` returns the first of the next month, the SQL uses
-- `created_at < _to`, and cpa-reports.ts states it); and the parent's timezone
-- is used deliberately, matching `franchise_rollup`, which reasons about the
-- choice in its own comment.
--
-- ── EXPOSURE ──────────────────────────────────────────────────────────────
--
-- Latent, as with everything else in BUILD-6: no organization has a parent or
-- is a franchise parent, and franchise_royalty_invoices holds zero rows. Each
-- probe had to build a franchise before it had anything to get wrong.

-- ── 1 ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_franchise_invoice_release_on_void()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  IF NEW.status = 'void' AND OLD.status IS DISTINCT FROM 'void' THEN
    -- Back to outstanding, so the next statement picks them up. `reversed` is
    -- excluded: a reversed deduction is finished, not owed.
    UPDATE public.franchise_adjustments
       SET status = 'pending', applied_settlement_id = NULL
     WHERE applied_settlement_id = NEW.id
       AND status = 'applied';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS franchise_invoice_release_on_void ON public.franchise_royalty_invoices;
CREATE TRIGGER franchise_invoice_release_on_void
  AFTER UPDATE OF status ON public.franchise_royalty_invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_franchise_invoice_release_on_void();

-- ── 2 ──────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_franchise_invoice_block_stale_issue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE _live bigint;
BEGIN
  IF NEW.status = 'issued' AND OLD.status = 'draft' THEN
    -- The invariant, not a proxy for it: the total printed on the statement
    -- must equal the adjustments that are actually on it.
    --
    -- The first version of this asked "is any adjustment on this statement
    -- reversed", which is a one-way door — the reversed row stays linked, so
    -- the statement could never be issued even after being regenerated. That
    -- showed up on the first probe of the fix.
    SELECT coalesce(sum(fa.location_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id = NEW.parent_organization_id), 0)
         - coalesce(sum(fa.franchise_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id IS DISTINCT FROM NEW.parent_organization_id), 0)
      INTO _live
      FROM public.franchise_adjustments fa
     WHERE fa.applied_settlement_id = NEW.id
       AND fa.status = 'applied';

    IF coalesce(_live, 0) IS DISTINCT FROM NEW.adjustments_applied_cents THEN
      RAISE EXCEPTION 'This statement says % in adjustments and the adjustments on it now total %. Regenerate it before issuing, so it shows what is actually owed.',
        NEW.adjustments_applied_cents, coalesce(_live, 0)
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS franchise_invoice_block_stale_issue ON public.franchise_royalty_invoices;
CREATE TRIGGER franchise_invoice_block_stale_issue
  BEFORE UPDATE OF status ON public.franchise_royalty_invoices
  FOR EACH ROW EXECUTE FUNCTION public.tg_franchise_invoice_block_stale_issue();

-- ── 3 + 4 ──────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.generate_franchise_settlements(_parent uuid, _start date, _end date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _n integer := 0;
  _tz text;
  _from timestamptz;
  _to timestamptz;
BEGIN
  IF NOT (
    public.has_role(auth.uid(), _parent, 'owner'::public.app_role)
    OR public.is_platform_admin(auth.uid())
    OR auth.role() = 'service_role'
  ) THEN
    RAISE EXCEPTION 'Only the franchise owner can generate settlements.';
  END IF;
  IF _end <= _start THEN
    RAISE EXCEPTION 'The period end must be after its start.';
  END IF;

  SELECT coalesce(timezone, 'America/Chicago') INTO _tz
    FROM public.organizations WHERE id = _parent;
  _from := _start::timestamp AT TIME ZONE _tz;
  _to   := _end::timestamp   AT TIME ZONE _tz;

  WITH kids AS (
    SELECT o.id,
           -- The rate a period settles at is the rate it was FIRST settled at.
           -- Reading it live restated closed months every time the owner
           -- changed a location's percentage. There is no rate-history table,
           -- so the existing statement IS the history.
           coalesce(
             (SELECT fri.royalty_percent
                FROM public.franchise_royalty_invoices fri
               WHERE fri.child_organization_id = o.id
                 AND fri.period_start = _start
                 AND fri.period_end   = _end),
             o.franchise_royalty_percent,
             0
           ) AS pct
    FROM public.organizations o WHERE o.parent_organization_id = _parent
  ),
  rev AS (
    SELECT k.id AS child, k.pct,
           coalesce(sum(p.amount_cents) FILTER (WHERE p.collected_by_organization_id = _parent), 0)::bigint AS by_parent,
           coalesce(sum(p.amount_cents) FILTER (WHERE p.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS by_location,
           coalesce(sum(p.amount_cents), 0)::bigint AS total
    FROM kids k
    LEFT JOIN public.payments p
      ON p.organization_id = k.id
     AND p.status IN ('succeeded', 'refunded')
     AND p.created_at >= _from
     AND p.created_at <  _to
    GROUP BY k.id, k.pct
  ),
  adj AS (
    SELECT fa.child_organization_id AS child,
           coalesce(sum(fa.location_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id = _parent), 0)::bigint AS loc_owes,
           coalesce(sum(fa.franchise_share_cents)
                    FILTER (WHERE fa.collected_by_organization_id IS DISTINCT FROM _parent), 0)::bigint AS fran_owes
    FROM public.franchise_adjustments fa
    LEFT JOIN public.franchise_royalty_invoices fri ON fri.id = fa.applied_settlement_id
    WHERE fa.parent_organization_id = _parent
      -- Only what was already known when the period closed. Without this an
      -- adjustment landed on whichever statement happened to be cut first.
      AND fa.created_at < _to
      AND (
        fa.status = 'pending'
        OR (fa.status = 'applied'
            AND fri.period_start = _start
            AND fri.period_end = _end
            AND fri.status = 'draft')
      )
    GROUP BY fa.child_organization_id
  ),
  calc AS (
    SELECT r.child, r.pct, r.by_parent, r.by_location, r.total,
           round(r.total * r.pct / 100.0)::bigint AS royalty,
           coalesce(a.loc_owes, 0) AS loc_owes,
           coalesce(a.fran_owes, 0) AS fran_owes,
           (r.by_parent
            - round(r.total * r.pct / 100.0)
            - coalesce(a.loc_owes, 0)
            + coalesce(a.fran_owes, 0))::bigint AS balance
    FROM rev r LEFT JOIN adj a ON a.child = r.child
  ),
  ins AS (
    INSERT INTO public.franchise_royalty_invoices (
      parent_organization_id, child_organization_id, period_start, period_end,
      revenue_cents, royalty_percent, amount_cents,
      direction, royalty_cents, net_due_cents,
      revenue_collected_by_parent_cents, revenue_collected_by_location_cents,
      adjustments_applied_cents, status, created_by
    )
    SELECT _parent, child, _start, _end,
           total, pct, royalty,
           CASE WHEN balance > 0 THEN 'franchise_owes_location'
                WHEN balance < 0 THEN 'location_owes_franchise'
                ELSE 'settled' END,
           royalty, abs(balance),
           by_parent, by_location,
           loc_owes - fran_owes, 'draft', auth.uid()
    FROM calc
    ON CONFLICT (child_organization_id, period_start, period_end) DO UPDATE
      SET revenue_cents = EXCLUDED.revenue_cents,
          royalty_percent = EXCLUDED.royalty_percent,
          amount_cents = EXCLUDED.amount_cents,
          direction = EXCLUDED.direction,
          royalty_cents = EXCLUDED.royalty_cents,
          net_due_cents = EXCLUDED.net_due_cents,
          revenue_collected_by_parent_cents = EXCLUDED.revenue_collected_by_parent_cents,
          revenue_collected_by_location_cents = EXCLUDED.revenue_collected_by_location_cents,
          adjustments_applied_cents = EXCLUDED.adjustments_applied_cents
      WHERE public.franchise_royalty_invoices.status = 'draft'
    RETURNING id, child_organization_id
  ),
  consume AS (
    UPDATE public.franchise_adjustments fa
       SET status = 'applied', applied_settlement_id = i.id
      FROM ins i
     WHERE fa.child_organization_id = i.child_organization_id
       AND fa.parent_organization_id = _parent
       AND fa.status = 'pending'
       -- Must match `adj` exactly. Consuming something the statement did not
       -- count would strand it, which is defect 1 by another route.
       AND fa.created_at < _to
    RETURNING fa.id
  )
  SELECT count(*)::integer INTO _n FROM ins;

  RETURN _n;
END;
$function$;

DO $$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE c.relname = 'franchise_royalty_invoices' AND NOT t.tgisinternal
     AND t.tgname IN ('franchise_invoice_release_on_void',
                      'franchise_invoice_block_stale_issue');
  IF _n <> 2 THEN
    RAISE EXCEPTION 'expected both statement triggers, found %', _n;
  END IF;

  IF (SELECT count(*) FROM regexp_matches(
        (SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public' AND p.proname = 'generate_franchise_settlements'),
        'fa\.created_at < _to', 'g')) <> 2 THEN
    RAISE EXCEPTION 'the period filter must appear in BOTH adj and consume, or an adjustment gets consumed without being counted';
  END IF;
END $$;
