-- Impersonation marker on tenant activity (QA round 3, deferred H2 item).
--
-- consumeImpersonation stores the minted auth session's JWT session_id on the
-- grant; logActivity resolves the current request's session id against unended
-- grants and stamps meta.impersonation on activity rows written during
-- impersonation. Exact session-id keying — no heuristic actor lookups — so the
-- protected multi-tab session isolation cannot produce false positives.

alter table public.impersonation_grants
  add column if not exists auth_session_id uuid;

-- One active (unended) grant per auth session; partial index keeps the
-- logActivity lookup a cheap exact-match probe.
create unique index if not exists impersonation_grants_auth_session_active_idx
  on public.impersonation_grants (auth_session_id)
  where auth_session_id is not null and ended_at is null;
