-- BUILD-12, third pass: two ways the dispute handler moved money that never moved.
--
-- Both were found by review before any org had a dispute (review_items holds
-- zero payment_* rows today), so there is nothing to repair — but both would
-- have hit the first franchise location to receive a customer inquiry.
--
-- ── A. AN INQUIRY IS NOT A CHARGEBACK ──────────────────────────────────────
--
-- Stripe sends `charge.dispute.created` and `charge.dispute.closed` for TWO
-- different things and only `status` tells them apart. `warning_needs_response`,
-- `warning_under_review` and `warning_closed` are an INQUIRY — the cardholder's
-- bank asking a question. No funds are withdrawn; the dispute's
-- `balance_transactions` array is empty, which is Stripe's own signal for
-- whether money moved. `warning_closed` is the GOOD ending: the question was
-- dropped and it never became a chargeback.
--
-- The handler treated every `created` as a withdrawal and every non-`won`
-- `closed` as a loss. On a $600 inquiry against a franchise location that is:
--
--     the payment marked 'refunded'          → −$600 from analytics, /reports
--                                              and the CPA pack, permanently
--     record_franchise_adjustment('chargeback', 60000)
--                                            → the location billed $600 for
--                                              money nobody ever took
--     warning_closed → payment_chargeback_lost
--                                            → /disputes reads "Decided in the
--                                              customer's favour", so the
--                                              deduction is now final and the
--                                              owner is told they lost a fight
--                                              that never happened
--
-- So two status-only kinds are added — `payment_dispute_inquiry` and
-- `payment_dispute_inquiry_closed`. They are filed so an inquiry is VISIBLE
-- (it has a response window, and ignoring it is how it becomes a chargeback)
-- and they move no money at all. `record_franchise_adjustment` refuses them the
-- way it already refuses `chargeback_lost`, because that function treats an
-- unknown kind as a brand-new deduction to apportion.
--
-- ── B. A SECOND DISPUTE ON A PAYMENT WAS SILENTLY DISCARDED ────────────────
--
-- `review_items` is UNIQUE (organization_id, kind, subject_id) and
-- `file_reversal_review_item` inserts ON CONFLICT DO NOTHING, so a payment
-- could hold exactly ONE row per kind — one dispute per payment, for ever.
-- A payment can genuinely be disputed more than once: an inquiry that
-- escalates into a chargeback is a NEW Stripe dispute object, and a charge can
-- carry two partial disputes.
--
-- What happened to the second one:
--
--   * the review item conflicted and vanished, so the real chargeback — the
--     one with the evidence deadline — never appeared in /disputes;
--   * `record_franchise_adjustment` read the FIRST dispute's amount as an
--     already-billed cumulative total. Two real disputes of $400 and $600 on a
--     $1,000 charge billed the location $400 + ($600 − $400) = $600 against
--     $1,000 actually clawed back: a $400 shortfall the franchise silently eats;
--   * if the second dispute was later won, the `chargeback_won` branch took
--     `ORDER BY created_at LIMIT 1` and reversed the FIRST adjustment — the
--     wrong one — and the payment flipped back to 'succeeded', restoring the
--     whole $1,000 of gross revenue while the bank still held $400.
--
-- The fix is to give both ledgers the thing that actually identifies a dispute:
-- Stripe's dispute id. `review_items.dispute_ref` (NOT NULL DEFAULT '' so every
-- other kind keeps its one-row-per-subject behaviour untouched) joins the
-- uniqueness key; `franchise_adjustments.dispute_ref` gets its own unique index
-- so a chargeback is idempotent per DISPUTE instead of per payment, and is
-- ADDITIVE across disputes rather than being read as a cumulative restatement
-- of the first. Refunds are unchanged: Stripe's `amount_refunded` really is
-- cumulative, so those still carry a NULL ref and the cumulative arithmetic.
--
-- Idempotent.

-- ── review_items: a dispute row is identified by its Stripe dispute ────────

ALTER TABLE public.review_items
  ADD COLUMN IF NOT EXISTS dispute_ref text NOT NULL DEFAULT '';

COMMENT ON COLUMN public.review_items.dispute_ref IS
  'BUILD-12: Stripe dispute id (dp_…) for the dispute kinds, '''' for every other kind. Part of the uniqueness key so a payment can carry more than one dispute over its life; before this, the second dispute on a payment conflicted and was silently dropped.';

ALTER TABLE public.review_items
  DROP CONSTRAINT IF EXISTS review_items_organization_id_kind_subject_id_key;
DROP INDEX IF EXISTS public.review_items_organization_id_kind_subject_id_key;

CREATE UNIQUE INDEX IF NOT EXISTS review_items_org_kind_subject_dispute_key
  ON public.review_items (organization_id, kind, subject_id, dispute_ref);

-- The two status-only inquiry kinds.
ALTER TABLE public.review_items DROP CONSTRAINT IF EXISTS review_items_kind_check;
ALTER TABLE public.review_items ADD CONSTRAINT review_items_kind_check CHECK (
  kind = ANY (ARRAY[
    'visit_timestamps_unreliable',
    'visit_started_never_finished',
    'visit_stuck_in_progress',
    'payment_refunded',
    'payment_chargeback',
    'payment_chargeback_won',
    'payment_chargeback_lost',
    -- Neither of these moves a cent. They exist so an inquiry is visible while
    -- its response window is open, and so its ending is recorded as the
    -- nothing-happened that it is.
    'payment_dispute_inquiry',
    'payment_dispute_inquiry_closed'
  ])
);

-- The visit scanner shares that unique index, so its conflict target has to
-- name the new column. It never sets one, so every row it files carries ''.
CREATE OR REPLACE FUNCTION public.detect_review_items(_org_id uuid DEFAULT NULL::uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _inserted integer := 0;
BEGIN
  WITH scoped AS (
    SELECT o.id AS org_id,
           (now() AT TIME ZONE coalesce(o.timezone, 'America/Chicago'))::date AS org_today
    FROM public.organizations o
    WHERE _org_id IS NULL OR o.id = _org_id
  ),
  found AS (
    SELECT v.organization_id,
           'visit_timestamps_unreliable'::text AS kind,
           v.id AS subject_id,
           'Start and completion were recorded as the same moment (or completion before start), so how long this visit actually took is unknown.'::text AS reason,
           jsonb_build_object(
             'scheduled_on', v.scheduled_on,
             'started_at', v.started_at,
             'completed_at', v.completed_at,
             'completion_source', v.completion_source
           ) AS detail
    FROM public.visits v
    JOIN scoped s ON s.org_id = v.organization_id
    WHERE v.started_at IS NOT NULL
      AND v.completed_at IS NOT NULL
      AND v.completed_at <= v.started_at

    UNION ALL

    SELECT v.organization_id,
           'visit_started_never_finished',
           v.id,
           'A tech started this visit but it was never completed, and the day it was scheduled for has passed. It is not clear whether the work happened.',
           jsonb_build_object('scheduled_on', v.scheduled_on, 'started_at', v.started_at)
    FROM public.visits v
    JOIN scoped s ON s.org_id = v.organization_id
    WHERE v.status = 'scheduled'
      AND v.started_at IS NOT NULL
      AND v.scheduled_on < s.org_today

    UNION ALL

    SELECT v.organization_id,
           'visit_stuck_in_progress',
           v.id,
           'This visit was left in progress and its scheduled day has passed. It needs someone to confirm whether it was completed.',
           jsonb_build_object('scheduled_on', v.scheduled_on, 'started_at', v.started_at)
    FROM public.visits v
    JOIN scoped s ON s.org_id = v.organization_id
    WHERE v.status = 'in_progress'
      AND v.scheduled_on < s.org_today
  ),
  ins AS (
    INSERT INTO public.review_items
      (organization_id, kind, subject_table, subject_id, reason, detail)
    SELECT f.organization_id, f.kind, 'visits', f.subject_id, f.reason, f.detail
    FROM found f
    -- Still "never reopen an item a human already decided" (BUILD-10); the
    -- fourth column is the constant '' for every row this function writes.
    ON CONFLICT (organization_id, kind, subject_id, dispute_ref) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO _inserted FROM ins;

  RETURN _inserted;
END;
$function$;

COMMENT ON FUNCTION public.detect_review_items(uuid) IS
  'BUILD-10: scans for records no automated process can resolve confidently and files one review_item each. Idempotent — ON CONFLICT DO NOTHING means a resolved or dismissed item is never reopened. Org-local dates. Mirrored by src/lib/review-queue.ts with a parity test. Called from the nightly hook.';

-- ── the filer: per-dispute identity, and the two inquiry kinds ─────────────
--
-- Replaced rather than overloaded: a sixth defaulted parameter alongside the
-- old five-parameter function would make every existing five-argument call
-- ambiguous and fail at runtime.
DROP FUNCTION IF EXISTS public.file_reversal_review_item(uuid, uuid, text, bigint, uuid);

CREATE OR REPLACE FUNCTION public.file_reversal_review_item(
  _org_id uuid,
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _adjustment_id uuid DEFAULT NULL,
  _dispute_ref text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _item_kind text;
  _reason text;
  _money text := '$' || to_char(_amount_cents / 100.0, 'FM999999990.00');
  _ref text := coalesce(_dispute_ref, '');
  _id uuid;
BEGIN
  _item_kind := CASE _kind
    WHEN 'refund' THEN 'payment_refunded'
    WHEN 'chargeback' THEN 'payment_chargeback'
    WHEN 'chargeback_won' THEN 'payment_chargeback_won'
    WHEN 'chargeback_lost' THEN 'payment_chargeback_lost'
    WHEN 'dispute_inquiry' THEN 'payment_dispute_inquiry'
    WHEN 'dispute_inquiry_closed' THEN 'payment_dispute_inquiry_closed'
    ELSE NULL END;
  IF _item_kind IS NULL THEN RETURN NULL; END IF;

  -- A refund is not a dispute and has no dispute id; forcing one in would split
  -- its idempotency key and let a redelivered refund file twice.
  IF _item_kind = 'payment_refunded' THEN _ref := ''; END IF;

  _reason := CASE _kind
    WHEN 'refund' THEN _money || ' was refunded to a customer. This revenue has been removed from your totals; if it was already counted in a franchise settlement it carries into the next one.'
    WHEN 'chargeback' THEN _money || ' was charged back by a customer''s bank. The money has left the account. You have limited time to submit evidence in Stripe if you want to dispute it.'
    WHEN 'chargeback_won' THEN _money || ' chargeback was WON — the money has been returned and any deduction taken for it has been reversed.'
    -- Says plainly that nothing was taken. Reading an inquiry as a withdrawal
    -- is the whole of defect A: it deducted revenue and billed a franchise
    -- location for money that was never removed from anyone's account.
    WHEN 'dispute_inquiry' THEN 'A customer''s bank has queried a ' || _money || ' charge. NO money has been taken and your revenue is unchanged. Answering the inquiry in Stripe is how it stays that way — an unanswered inquiry is what becomes a chargeback.'
    WHEN 'dispute_inquiry_closed' THEN 'The bank''s query about a ' || _money || ' charge was dropped without becoming a chargeback. No money ever left the account and none is owed.'
    -- Deliberately says no money moved. The withdrawal happened when the
    -- dispute opened; a reader seeing a second dollar figure would reasonably
    -- assume they had been hit twice.
    ELSE 'The ' || _money || ' chargeback was decided in the customer''s favour. No further money moves — it left when the dispute opened — but this sale is now final as lost.'
  END;

  INSERT INTO public.review_items (
    organization_id, kind, subject_table, subject_id, reason, detail, dispute_ref
  )
  VALUES (
    _org_id, _item_kind, 'payments', _payment_id, _reason,
    jsonb_build_object(
      'amount_cents', _amount_cents,
      'adjustment_id', _adjustment_id,
      'dispute_id', nullif(_ref, '')
    ),
    _ref
  )
  -- Redelivery of the SAME dispute still does nothing; a DIFFERENT dispute on
  -- the same payment now gets its own row instead of disappearing.
  ON CONFLICT (organization_id, kind, subject_id, dispute_ref) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$$;

COMMENT ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text) IS
  'BUILD-12: files a review-queue entry when money is refunded or charged back, when a dispute is decided, and when a bank raises or drops an inquiry. Idempotent per DISPUTE (dispute_ref), so a payment disputed twice files two rows instead of losing the second. ''chargeback_lost'' records STATE only — the money left when the dispute opened. The two ''dispute_inquiry'' kinds move nothing at all: an inquiry withdraws no funds.';

REVOKE ALL ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.file_reversal_review_item(uuid, uuid, text, bigint, uuid, text) TO service_role;

-- ── franchise adjustments: one deduction per DISPUTE ───────────────────────

ALTER TABLE public.franchise_adjustments
  ADD COLUMN IF NOT EXISTS dispute_ref text;

COMMENT ON COLUMN public.franchise_adjustments.dispute_ref IS
  'BUILD-12: Stripe dispute id for a chargeback deduction and for the reversal that repays it. NULL for refunds and manual adjustments, whose amounts are cumulative rather than per-event. Makes a chargeback idempotent per dispute instead of per payment.';

CREATE UNIQUE INDEX IF NOT EXISTS franchise_adjustments_payment_kind_dispute_key
  ON public.franchise_adjustments (payment_id, kind, dispute_ref)
  WHERE dispute_ref IS NOT NULL;

DROP FUNCTION IF EXISTS public.record_franchise_adjustment(uuid, text, bigint, text);

CREATE OR REPLACE FUNCTION public.record_franchise_adjustment(
  _payment_id uuid,
  _kind text,
  _amount_cents bigint,
  _note text DEFAULT NULL::text,
  _dispute_ref text DEFAULT NULL::text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  _child uuid; _parent uuid; _pct numeric; _resp text; _collector uuid;
  _fran bigint; _loc bigint; _id uuid;
  _orig public.franchise_adjustments%ROWTYPE;
  _settled boolean;
  _already bigint;
  _delta bigint;
  _ref text := nullif(trim(coalesce(_dispute_ref, '')), '');
BEGIN
  -- A lost dispute and an inquiry both move NOTHING. The generic branch at the
  -- bottom treats any kind it does not recognise as a brand-new deduction, so
  -- an unrefused kind here bills a location for the full amount: $1,000 twice
  -- on a lost $1,000 chargeback, or $600 for a $600 inquiry that took nothing.
  IF _kind IN ('chargeback_lost', 'dispute_inquiry', 'dispute_inquiry_closed') THEN
    RETURN NULL;
  END IF;

  SELECT p.organization_id, o.parent_organization_id,
         coalesce(o.franchise_royalty_percent, 0), o.chargeback_responsibility,
         coalesce(p.collected_by_organization_id, p.organization_id)
    INTO _child, _parent, _pct, _resp, _collector
    FROM public.payments p JOIN public.organizations o ON o.id = p.organization_id
   WHERE p.id = _payment_id;

  IF _parent IS NULL THEN RETURN NULL; END IF;

  IF _kind = 'chargeback_won' THEN
    -- Reverse the deduction for THIS dispute. `ORDER BY created_at LIMIT 1`
    -- alone reversed the oldest chargeback on the payment, which on a payment
    -- disputed twice is the wrong one — repaying a settled $400 while the
    -- $600 the bank actually returned stayed billed.
    IF _ref IS NOT NULL THEN
      SELECT * INTO _orig FROM public.franchise_adjustments
       WHERE payment_id = _payment_id AND kind = 'chargeback'
         AND dispute_ref = _ref
         AND status IN ('pending', 'applied')
       LIMIT 1;
    END IF;
    IF _orig.id IS NULL THEN
      -- Fallback for a deduction filed before dispute ids were recorded. Only
      -- ref-less rows are eligible, so it can never steal another dispute's.
      SELECT * INTO _orig FROM public.franchise_adjustments
       WHERE payment_id = _payment_id AND kind = 'chargeback'
         AND dispute_ref IS NULL
         AND status IN ('pending', 'applied')
       ORDER BY created_at
       LIMIT 1;
    END IF;
    IF _orig.id IS NULL THEN RETURN NULL; END IF;

    SELECT EXISTS (
      SELECT 1 FROM public.franchise_royalty_invoices fri
       WHERE fri.id = _orig.applied_settlement_id AND fri.status <> 'draft'
    ) INTO _settled;

    UPDATE public.franchise_adjustments
       SET status = 'reversed', reversed_at = now()
     WHERE id = _orig.id;

    IF NOT _settled THEN
      RETURN _orig.id;
    END IF;

    INSERT INTO public.franchise_adjustments (
      parent_organization_id, child_organization_id, payment_id,
      kind, amount_cents, cumulative_cents,
      franchise_share_cents, location_share_cents,
      collected_by_organization_id, note, dispute_ref
    )
    VALUES (
      _orig.parent_organization_id, _orig.child_organization_id, _payment_id,
      'chargeback_won', _orig.amount_cents, _orig.amount_cents,
      -_orig.franchise_share_cents, -_orig.location_share_cents,
      _orig.collected_by_organization_id,
      coalesce(_note, 'Chargeback won — repaying a deduction already settled'),
      _orig.dispute_ref
    )
    ON CONFLICT (payment_id, kind, cumulative_cents) DO NOTHING
    RETURNING id INTO _id;

    IF _id IS NOT NULL THEN
      UPDATE public.franchise_adjustments
         SET reversed_by_adjustment_id = _id
       WHERE id = _orig.id;
    END IF;
    RETURN coalesce(_id, _orig.id);
  END IF;

  SELECT coalesce(sum(amount_cents), 0) INTO _already
    FROM public.franchise_adjustments
   WHERE payment_id = _payment_id AND kind = _kind AND status <> 'reversed';

  IF _ref IS NOT NULL THEN
    -- A dispute is its own event with its own amount — NOT a restatement of
    -- an earlier one. Two disputes of $400 and $600 owe $1,000, and the
    -- cumulative arithmetic below billed $600. Idempotency comes from the
    -- dispute id instead, so a redelivered webhook still files nothing.
    IF EXISTS (
      SELECT 1 FROM public.franchise_adjustments
       WHERE payment_id = _payment_id AND kind = _kind AND dispute_ref = _ref
    ) THEN
      RETURN NULL;
    END IF;
    _delta := _amount_cents;
  ELSE
    -- Refunds keep the cumulative reading: Stripe's `amount_refunded` is a
    -- running total of the charge, so partial refunds must not re-bill.
    _delta := _amount_cents - _already;
  END IF;

  IF _delta <= 0 THEN RETURN NULL; END IF;

  IF _resp = 'franchise' THEN
    _fran := _delta; _loc := 0;
  ELSIF _resp = 'split' THEN
    _fran := round(_delta * _pct / 100.0)::bigint;
    _loc  := _delta - _fran;
  ELSE
    _fran := 0; _loc := _delta;
  END IF;

  INSERT INTO public.franchise_adjustments (
    parent_organization_id, child_organization_id, payment_id,
    kind, amount_cents, cumulative_cents,
    franchise_share_cents, location_share_cents,
    collected_by_organization_id, note, dispute_ref
  )
  VALUES (
    _parent, _child, _payment_id,
    _kind, _delta, _already + _delta,
    _fran, _loc,
    _collector, _note, _ref
  )
  ON CONFLICT (payment_id, kind, cumulative_cents) DO NOTHING
  RETURNING id INTO _id;

  RETURN _id;
END;
$function$;

COMMENT ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text, text) IS
  'BUILD-6/BUILD-12: apportions a refund or chargeback between a franchise and its location, freezing the policy and the collecting account in force at the time. A refund records the DELTA of Stripe''s cumulative amount_refunded; a CHARGEBACK is additive per dispute id, because two disputes on one charge owe the sum of both. Returns NULL for a lost dispute and for either inquiry kind — those are status changes, and an inquiry never took a cent.';

REVOKE ALL ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_franchise_adjustment(uuid, text, bigint, text, text) TO service_role;
