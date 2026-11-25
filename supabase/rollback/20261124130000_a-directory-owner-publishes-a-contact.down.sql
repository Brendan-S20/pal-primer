-- ROLLBACK for 20261124130000_a-directory-owner-publishes-a-contact.sql (#1002).
-- Drops the function only. Published contacts stay in the columns.
--   psql "$DB_URL" -v ON_ERROR_STOP=1 -f supabase/rollback/20261124130000_a-directory-owner-publishes-a-contact.down.sql
DROP FUNCTION IF EXISTS public.set_directory_public_contact(uuid, text, text, boolean, boolean);
