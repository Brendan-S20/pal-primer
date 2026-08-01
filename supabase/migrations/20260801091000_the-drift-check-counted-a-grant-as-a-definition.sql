-- The drift check counted a GRANT as a definition, so two more undeclared
-- functions walked straight past it.
--
-- BUG-75 added scripts/check-schema-declared.mjs to catch objects the database
-- has that no migration creates. Its own comment says:
--
--     "A GRANT or a comment mentioning the name is not a definition — the whole
--      point is that email_queue_wake appeared in a migration's GRANT list
--      while being defined nowhere. Only a CREATE FUNCTION counts."
--
-- And its implementation matched /FUNCTION\s+(public\.)?name\s*\(/ — which
--
--     GRANT EXECUTE ON FUNCTION public.name(uuid) TO authenticated;
--
-- satisfies exactly. So the check shipped carrying the precise hole it was
-- written to close, and reported "✓ every live function is declared" while two
-- were not. That is the eighth check in this codebase found green while
-- measuring nothing, and the fourth written by me.
--
-- Both survivors are granted TO anon in
-- 20260731190000_the-publishable-key-could-read-the-client-list.sql, are called
-- from the public marketing site, and are created by no migration. Filed here
-- verbatim from the live definitions — this records what runs, it does not
-- change it.
--
-- `roadmap_votes` has RLS enabled with zero policies, so these SECURITY DEFINER
-- routines are the only access path to it. That is deliberate and it is why
-- they are definer functions rather than plain table access.
--
-- cast_roadmap_vote has no authorization check and is reachable by `anon` —
-- checked, not assumed: has_function_privilege('anon', oid, 'EXECUTE') is true.
-- `p_voter` is caller-supplied, so anyone can stuff the roadmap poll by varying
-- it. Left as-is deliberately: it is an unauthenticated feature-request poll on
-- a marketing page, the format checks bound the damage to noise in a vote
-- count, and no money, PII or access decision hangs off it. Recorded so it is a
-- known trade-off rather than an oversight rediscovered later.

CREATE OR REPLACE FUNCTION public.cast_roadmap_vote(p_feature text, p_voter text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
begin
  if p_feature is null or p_feature !~ '^[a-z0-9-]{3,40}$' then
    raise exception 'invalid feature';
  end if;
  if p_voter is null or p_voter !~ '^[a-zA-Z0-9-]{8,64}$' then
    raise exception 'invalid voter';
  end if;
  insert into public.roadmap_votes (feature, voter_id)
  values (p_feature, p_voter)
  on conflict (feature, voter_id) do nothing;
end;
$function$;

CREATE OR REPLACE FUNCTION public.roadmap_vote_counts()
RETURNS TABLE(feature text, votes bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  select feature, count(*)::bigint from public.roadmap_votes group by feature;
$function$;

DO $$
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.proname IN ('cast_roadmap_vote', 'roadmap_vote_counts')) <> 2 THEN
    RAISE EXCEPTION 'both roadmap routines should exist';
  END IF;
  -- If this table ever gains a policy, the definer routines stop being the only
  -- door and the reasoning in the header no longer holds.
  IF EXISTS (SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
              WHERE c.relname = 'roadmap_votes') THEN
    RAISE EXCEPTION 'roadmap_votes now has policies — revisit why these are SECURITY DEFINER';
  END IF;
END $$;
