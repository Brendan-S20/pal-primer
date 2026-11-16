-- Proof for 20261112110000: a directory photo is public only after a
-- moderator approves it (#630; mypets v2 step 5b). A private storage bucket;
-- photos that start pending, carry alt text and the owner's attestation, and
-- stop at eight per business (rejected ones do not count); no self-approval;
-- a platform-admin queue that approves or rejects and records who and when;
-- directory_public_listings.photos with approved photos only, as HoundStack
-- paths with an opaque key, never a storage path, id, contact or address.
--
-- One copy of the proof, in tests/sql/, so the two runners cannot drift:
--   * CI's database job runs this file against the database it just built
--     from every migration (no :migration variable, nothing to apply);
--   * tests/a-directory-photo-waits-for-a-moderator.test.ts runs the same
--     proof with :migration set, against a local stack.
-- It ends in ROLLBACK and leaves nothing behind.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/proofs/20261112110000-a-directory-photo-is-public-only-after-a-moderator-approves-it.sql

\ir ../../tests/sql/a-directory-photo-waits-for-a-moderator.proof.sql
