// The Supabase project URL, for SERVER code.
//
// ── WHY THIS IS A CONSTANT AND NOT A SECRET ───────────────────────────────
//
// It is not secret. `src/integrations/supabase/client.ts` hard-codes this exact
// string and ships it to every browser, next to the anon key. Anyone with
// devtools has had it since the first deploy. Treating a public value as a
// secret is what broke transactional email for hours:
//
//   - six routes under src/routes/email/ read `import.meta.env.VITE_SUPABASE_URL`
//   - Vite INLINES that at build time, so when the variable was absent while the
//     bundle was built, the compiled output contained `undefined` — and nothing
//     added to a runtime secret store afterwards could change it
//   - `.env` is untracked (it was committed once; removing it was a security
//     fix), so the deployed build had no source for it
//   - and nothing else in the product noticed, because the browser client
//     hard-codes its own copy. The app signed in and worked perfectly while
//     every invoice, OTP, receipt and reminder went undelivered.
//
// The config guard returned an identical opaque 500 every minute for hours:
// 360 of 360 responses in `net._http_response`, naming none of the three
// variables it tests.
//
// ── THE ORDER, AND WHY ────────────────────────────────────────────────────
//
// An explicit env var still wins, so a preview/staging project can point
// elsewhere without a code change. `SUPABASE_URL` is checked before the VITE_
// name because the platform's own Supabase integration injects the former at
// runtime, and the latter only exists at build. The literal is last: it is a
// floor, not a preference — always correct for production, never silently
// wrong, and impossible to leave unset.
//
// Do NOT add the service role key or any other credential to this file. Those
// ARE secrets, they are runtime-only, and they must stay that way.

/** Public URL for `vsxzrbxublqrcfnxfwcu`, the production Supabase project.
 *
 *  The custom domain, activated 2026-08-19, not `vsxzrbxublqrcfnxfwcu.supabase.co`.
 *  Both serve the same project and the `.supabase.co` host keeps working — Supabase
 *  does not retire it — so this is a preference, not a cutover. It is the custom
 *  domain because that is the one that survives a project migration.
 *
 *  Changing this string alone is not enough: `src/integrations/supabase/client.ts`
 *  carries its own copy for the browser, and `tests/the-supabase-url-is-not-a-secret.test.ts`
 *  asserts the two agree. */
export const PUBLIC_SUPABASE_URL = "https://api.houndstack.com";

/**
 * The URL server code should use to reach Supabase.
 *
 * Never returns undefined, which is the whole point: the previous expression
 * could, and did, and the failure was invisible from the source.
 */
export function resolveSupabaseUrl(): string {
  const fromRuntimeEnv =
    typeof process !== "undefined"
      ? (process.env?.SUPABASE_URL ?? process.env?.VITE_SUPABASE_URL)
      : undefined;
  if (fromRuntimeEnv) return fromRuntimeEnv;

  // Build-time inline, when one was actually present at build.
  try {
    const fromBuild = import.meta.env?.VITE_SUPABASE_URL as string | undefined;
    if (fromBuild) return fromBuild;
  } catch {
    /* import.meta is unavailable in some runtimes; the literal below covers it */
  }

  return PUBLIC_SUPABASE_URL;
}
