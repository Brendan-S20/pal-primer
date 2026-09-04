-- A subscription's price did not record where it came from.
--
-- `subscriptions.price_cents` is captured once, when the service is created,
-- and only ever changes when a human edits it (or when a frequency change
-- reprices it by the exact ratio of the old and new multipliers). Nothing
-- alongside it says which zone's rate produced the number, when, or whether
-- somebody has since typed over it.
--
-- So "who is off the current rate card, and by how much" -- the first question
-- any repricing screen has to answer -- cannot be answered from this table.
-- Measured by hand on 2026-09-03: 18 of 21 active residential subscriptions
-- differ from what their zone computes today, and there is no way to tell an
-- old rate from a deliberate discount.
--
-- Sweep&Go's subscription record carries `price` next to `pricing_plan` and
-- `service_plan` for exactly this reason: keep the reference beside the
-- snapshot and the drift report needs no history table. This is that.
--
-- ── WHY NOT JUST USE zone_id ────────────────────────────────────────────────
--
-- `subscriptions.zone_id` is set at create and, as it happens, nothing rewrites
-- it: `redetectZonesForOrg` re-runs the matcher after every zone edit but
-- updates `properties` only. That makes it *look* like pricing provenance.
--
-- It is not, and relying on it would be relying on an accident. The redetect's
-- scope is not a documented guarantee, an admin can legitimately move a service
-- to another zone without meaning to restate what priced it, and the column
-- answers "which zone does this service belong to", which is a different
-- question from "which zone's rate produced this number". Two columns because
-- there are two questions.
--
-- ── NO BACKFILL, AND WHAT NULL MEANS ────────────────────────────────────────
--
-- Every existing row keeps NULL in all three. It would be easy to write
-- `priced_at = created_at` and `priced_from_zone_id = zone_id` and be right
-- most of the time -- but a subscription hand-edited last month would then
-- claim it was priced from its zone on the day it was created, and
-- `price_overridden_at IS NULL` would read as "nobody has touched this" when
-- the truth is "nobody recorded it". A false negative on the one question
-- these columns exist to answer is worse than no answer, so NULL means
-- "set before this was recorded" and the UI says exactly that.
--
-- Live drift stays computable for those rows regardless: comparing
-- `price_cents` against what the zone charges today needs no provenance. What
-- provenance adds is whether the gap was deliberate.

ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS priced_from_zone_id uuid REFERENCES public.zones(id) ON DELETE SET NULL;
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS priced_at timestamptz;
ALTER TABLE public.subscriptions
  ADD COLUMN IF NOT EXISTS price_overridden_at timestamptz;

COMMENT ON COLUMN public.subscriptions.priced_from_zone_id IS
  'The zone whose rate card was in force when price_cents was set. Distinct '
  'from zone_id, which is where the service is routed and which an admin may '
  'move without restating the price. NULL means the price predates this '
  'column, not that no zone was involved. ON DELETE SET NULL: losing the zone '
  'must not take the subscription with it.';
COMMENT ON COLUMN public.subscriptions.priced_at IS
  'When price_cents was last established. NULL means it predates this column.';
COMMENT ON COLUMN public.subscriptions.price_overridden_at IS
  'When a human last typed over the price on an EXISTING service. NULL means '
  'either nobody has, or the edit predates this column -- the UI must not '
  'render NULL as "never overridden". Deliberately not set by the frequency '
  'change, which reprices by the exact multiplier ratio and is the rate card '
  'being applied, not a person overruling it. Also not set at creation: the '
  'new-service form prefills from the zone and a person may edit it there, '
  'and the server cannot tell those apart -- such a service shows up as drift '
  'against its zone rather than as an override, which is what it is.';

-- An index on the drift question: the repricing screen asks for every
-- subscription priced from one zone. Partial, because a NULL here is the
-- "we do not know" case and no report wants those grouped under a zone.
CREATE INDEX IF NOT EXISTS subscriptions_priced_from_zone_idx
  ON public.subscriptions (priced_from_zone_id)
  WHERE priced_from_zone_id IS NOT NULL;

DO $verify$
DECLARE _n integer; _backfilled integer;
BEGIN
  SELECT count(*) INTO _n
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'subscriptions'
     AND column_name IN ('priced_from_zone_id', 'priced_at', 'price_overridden_at');
  IF _n <> 3 THEN
    RAISE EXCEPTION 'expected all three provenance columns, found %', _n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE schemaname = 'public' AND indexname = 'subscriptions_priced_from_zone_idx'
  ) THEN
    RAISE EXCEPTION 'the priced_from_zone index was not created';
  END IF;

  -- The foreign key must not cascade: deleting a zone would otherwise delete
  -- the subscriptions priced from it. Asserted because this migration
  -- establishes the constraint, so a replay can prove it from any state.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.subscriptions'::regclass
       AND contype = 'f'
       AND confdeltype = 'n'
       AND conkey = ARRAY[(
         SELECT attnum FROM pg_attribute
          WHERE attrelid = 'public.subscriptions'::regclass
            AND attname = 'priced_from_zone_id')]
  ) THEN
    RAISE EXCEPTION 'priced_from_zone_id is not ON DELETE SET NULL; a deleted zone could take services with it';
  END IF;

  -- A MEASUREMENT: this file backfills nothing, so on any database every row
  -- should still be NULL immediately after it runs. Warned rather than
  -- asserted because it counts rows this file did not create.
  SELECT count(*) INTO _backfilled FROM public.subscriptions WHERE priced_at IS NOT NULL;
  IF _backfilled > 0 THEN
    RAISE WARNING '% subscription(s) already carry priced_at; this migration did not set them', _backfilled;
  ELSE
    RAISE NOTICE 'provenance columns added, nothing backfilled -- NULL means "set before this was recorded".';
  END IF;
END
$verify$;
