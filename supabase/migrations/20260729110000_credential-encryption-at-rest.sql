-- IMP-1: third-party credentials are now encrypted at rest.
--
-- org_ai_credentials.api_key, org_twilio_credentials.auth_token, and
-- accounting_connections.access_token / refresh_token held plaintext. RLS kept
-- them out of tenant queries, but RLS is access control, not storage: a
-- database dump, a stray backup, a read replica, a support engineer with
-- console access, or any service-role bug reads them straight out. A tenant's
-- Twilio auth token is their money and their phone number; a QuickBooks OAuth
-- token is their books.
--
-- The columns keep their `text` type and now hold an AES-256-GCM envelope
-- produced in the application layer (src/lib/secret-encryption.server.ts).
-- Application-layer rather than pgsodium/Vault on purpose: with Vault the
-- DATABASE can decrypt, so a database compromise is a credential compromise.
-- Here the key lives only in the app environment and the database holds
-- ciphertext it cannot read. Nothing filters, joins, or sorts on these values —
-- they are fetched by server code and handed to an external API — so making
-- them opaque to SQL costs nothing.
--
-- No data migration: all three tables were EMPTY when this shipped (verified
-- against the live database), so there was no plaintext to convert and no
-- window where a half-migrated row could exist. Readers still pass through any
-- value lacking the version prefix as legacy plaintext, which keeps both
-- deploying and rolling back safe.
--
-- Idempotent.

-- Display hints. Settings pages show "•••• 4f2a" so an operator can tell which
-- key is installed; deriving that from the stored value is impossible now that
-- it is ciphertext, and decrypting a secret merely to render four characters
-- would be a poor trade. Captured at write time instead. Non-secret by
-- construction: four characters of a credential identify it without enabling
-- its use.
ALTER TABLE public.org_ai_credentials
  ADD COLUMN IF NOT EXISTS key_last4 text;

ALTER TABLE public.org_twilio_credentials
  ADD COLUMN IF NOT EXISTS token_last4 text;

COMMENT ON COLUMN public.org_ai_credentials.api_key IS
  'AES-256-GCM ciphertext, "v1.<iv>.<tag>.<ciphertext>" in base64url. Encrypted and decrypted in the application layer; the database cannot read this. Never write a raw key here.';

COMMENT ON COLUMN public.org_ai_credentials.key_last4 IS
  'Last 4 characters of the plaintext key, for display only. Captured at write time so rendering settings never requires decryption.';

COMMENT ON COLUMN public.org_twilio_credentials.auth_token IS
  'AES-256-GCM ciphertext (see org_ai_credentials.api_key). Never write a raw token here.';

COMMENT ON COLUMN public.org_twilio_credentials.token_last4 IS
  'Last 4 characters of the plaintext auth token, for display only.';

COMMENT ON COLUMN public.accounting_connections.access_token IS
  'AES-256-GCM ciphertext (see org_ai_credentials.api_key). Decrypted only in ensureFreshToken(), the single funnel every accounting API path passes through.';

COMMENT ON COLUMN public.accounting_connections.refresh_token IS
  'AES-256-GCM ciphertext. A rotated refresh token is re-encrypted on the way back down — it is as sensitive as the original.';
