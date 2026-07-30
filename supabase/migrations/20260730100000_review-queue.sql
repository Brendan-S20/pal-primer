-- BUILD-10: the review queue §10.5 has been referring to all along.
--
-- Guardrail 10.5 reads: "Ambiguous records go to a review queue — never
-- silently guessed." The guardrail was written as though the queue existed. It
-- did not. So the rule the project measures itself against pointed at a
-- mechanism nobody had built, and every place that honored the rule honored it
-- by doing nothing.
--
-- Two concrete examples of "nothing":
--
--   * BUG-9's visits — start and completion recorded as the same instant, so
--     the duration is unknowable. The condition was detected CLIENT-side, one
--     row at a time, only if a human happened to open that one client's Visits
--     tab. There was no way to ask how many existed. (There are 2.)
--
--   * admin_transition_missed_visits says, verbatim, "Ambiguous records are
--     LEFT for human review (I5)". Nothing received them. A visit a tech
--     started and never finished simply sat in 'scheduled' forever, invisible
--     except as a number on a platform-admin health tile. (There is 1.)
--
-- WHAT THIS IS NOT. It is an INDEX of ambiguity, not a second editing surface.
-- Resolving an item records the human decision; the actual correction happens
-- through the flow that already owns that record (correctVisitTimestamps,
-- confirm_open_visit). Re-implementing remediation here would mean two code
-- paths that can disagree about the same fix, which is how the underlying bugs
-- got written in the first place.
--
-- IT BLOCKS NOTHING (owner decision). Billing, reports, and analytics behave
-- exactly as before. An unresolved item is a visible piece of work, not a
-- tripwire. Disputed INVOICES are a separate concern with their own queue and
-- an analytics toggle — deliberately not conflated with this.
--
-- WHO RESOLVES (owner decision). The org owner. The knowledge required to
-- resolve "did this visit actually happen" lives with the tenant, not with us —
-- resolving it on their behalf would be the silent guess the guardrail forbids.
-- Platform admins get read-across for oversight, not resolution.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS public.review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- text + CHECK rather than an enum, matching the house style for new status
  -- columns: adding a detector shouldn't need an ALTER TYPE.
  kind text NOT NULL CHECK (kind IN (
    'visit_timestamps_unreliable',   -- completed_at <= started_at (the BUG-9 signature)
    'visit_started_never_finished',  -- past 'scheduled' row carrying a started_at (I5)
    'visit_stuck_in_progress'        -- 'in_progress' after its day ended
  )),

  -- What the item is about. Deliberately loose (table name + id) rather than a
  -- FK per kind: a review queue that needs a schema change to describe a new
  -- kind of ambiguity will stop being used the first time that is inconvenient.
  subject_table text NOT NULL,
  subject_id uuid NOT NULL,

  -- Written for a human, at detection time, in terms of what is actually
  -- uncertain. Not an error code.
  reason text NOT NULL CHECK (char_length(reason) <= 500),
  -- The evidence, so the UI never has to re-derive why this was flagged.
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,

  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'dismissed')),

  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by uuid,
  -- Required by the server when leaving 'open' — see the app-layer gate. A
  -- resolution with no account of what was decided is the same silence this
  -- table exists to end.
  resolution_note text CHECK (char_length(resolution_note) <= 500),

  -- One row per (org, kind, subject). This is what makes re-running detection
  -- safe, and what stops a resolved item being resurrected on the next sweep
  -- because the underlying condition is still technically true. A human's
  -- decision outlives the detector.
  UNIQUE (organization_id, kind, subject_id)
);

CREATE INDEX IF NOT EXISTS review_items_org_status_idx
  ON public.review_items (organization_id, status, detected_at DESC);
CREATE INDEX IF NOT EXISTS review_items_subject_idx
  ON public.review_items (subject_table, subject_id);

ALTER TABLE public.review_items ENABLE ROW LEVEL SECURITY;

-- Read: any org member. Seeing that a record is uncertain is not privileged;
-- acting on it is.
DROP POLICY IF EXISTS review_items_select ON public.review_items;
CREATE POLICY review_items_select ON public.review_items
  FOR SELECT TO authenticated
  USING (
    public.is_org_member(auth.uid(), organization_id)
    OR public.is_platform_admin(auth.uid())
  );

-- Write: office roles only, and only their own org's rows. Platform admins are
-- deliberately NOT granted write — they can see everything and resolve nothing,
-- because resolving requires knowledge they do not have.
DROP POLICY IF EXISTS review_items_update ON public.review_items;
CREATE POLICY review_items_update ON public.review_items
  FOR UPDATE TO authenticated
  USING (public.can_write_org(auth.uid(), organization_id))
  WITH CHECK (public.can_write_org(auth.uid(), organization_id));

-- No INSERT policy on purpose: rows come only from the detector below, running
-- as service_role. A tenant cannot manufacture review items.
GRANT SELECT, UPDATE ON public.review_items TO authenticated;
GRANT ALL ON public.review_items TO service_role;

COMMENT ON TABLE public.review_items IS
  'BUILD-10 / guardrail 10.5: records an automated process could not resolve confidently. An index of ambiguity, not an editing surface — remediation happens through the flow that owns the record. Blocks nothing. Detected by detect_review_items(); resolved by the org owner.';

-- ── The detector ────────────────────────────────────────────────────────────
--
-- Mirrored in TypeScript by src/lib/review-queue.ts, with a parity test
-- (tests/review-queue.test.ts) replaying the same fixtures against both — the
-- same guard IMP-3 put on permissions and BUILD-1 put on entitlements. A
-- detector that disagrees with its own UI about what counts as ambiguous is
-- worse than no detector.
--
-- Org-LOCAL dates throughout. Using the database's UTC "today" here would flag
-- visits as overdue for review hours before the org's own day had ended — the
-- BUG-12 mistake, which has now appeared three times in this codebase.
--
-- ON CONFLICT DO NOTHING is load-bearing: it means a resolved or dismissed item
-- is never reopened by a later sweep. If a human looked at it and decided, that
-- decision stands until someone changes it deliberately.

CREATE OR REPLACE FUNCTION public.detect_review_items(_org_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
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
    -- BUG-9's signature. Completion at or before start cannot be a real
    -- service duration, so the timestamps contradict each other and the truth
    -- is unrecoverable from the data alone.
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

    -- The I5 case admin_transition_missed_visits explicitly refuses to sweep:
    -- a tech began the visit, so it is not simply a no-show, but it never
    -- completed. Only a human knows which.
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

    -- Left 'in_progress' past its day. BUILD-11's close-out prompt catches
    -- these while the tech is still in the app; anything that escapes it lands
    -- here rather than sitting in limbo indefinitely.
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
    ON CONFLICT (organization_id, kind, subject_id) DO NOTHING
    RETURNING 1
  )
  SELECT count(*)::integer INTO _inserted FROM ins;

  RETURN _inserted;
END;
$$;

COMMENT ON FUNCTION public.detect_review_items(uuid) IS
  'BUILD-10: scans for records no automated process can resolve confidently and files one review_item each. Idempotent — ON CONFLICT DO NOTHING means a resolved or dismissed item is never reopened. Org-local dates. Mirrored by src/lib/review-queue.ts with a parity test. Called from the nightly hook.';

REVOKE ALL ON FUNCTION public.detect_review_items(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.detect_review_items(uuid) TO service_role;
