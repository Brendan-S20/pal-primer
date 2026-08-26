# Turning on Google, Apple and Facebook sign-in

Status on 2026-08-25, measured rather than assumed —
`npm run check:oauth` produces this table live:

| provider | Supabase | button in the UI | works end to end? |
|---|---|---|---|
| Google   | **enabled** | disabled | **no** — `redirect_uri_mismatch` at Google |
| Apple    | disabled | disabled | not configured |
| Facebook | disabled | disabled | not configured |

All three buttons are currently dead on purpose, and the whole OAuth block is
hidden in the iOS binary (`!IS_NATIVE_BUNDLE` in `src/routes/auth.tsx`). Email
sign-in is the only live path on every platform.

## The one URL all three need

```
https://api.houndstack.com/auth/v1/callback
```

This is Supabase's callback, not ours. Every provider console needs it in its
allow-list, and a provider that does not have it rejects the request at the
provider's own domain — which is invisible to the app. See "Why the app could
not catch this" below.

---

## 1. Google — one console change away

The client already exists and Supabase already has its credentials. The single
missing thing is the redirect URI on Google's side.

**Client:** `983772724082-m8ngfmm0d35ks1qch8p0ujtv04us6h5r.apps.googleusercontent.com`

1. Google Cloud Console → **APIs & Services → Credentials**
2. Open that OAuth 2.0 Client ID
3. **Authorised redirect URIs** → Add → `https://api.houndstack.com/auth/v1/callback`
4. **Authorised JavaScript origins** → Add → `https://app.houndstack.com`
5. Save, then wait — Google takes anywhere from a minute to an hour to
   propagate. Re-run `npm run check:oauth` until Google reads `OK`.
6. Only then, in `src/routes/auth.tsx`, remove `disabled` from the Google
   button and restore `onClick={() => oauthSignIn("google")}`.

Do step 6 last. The order is the whole lesson from the 2026-08-25 regression:
the button went live before the console did, and every buyer who pressed it got
`Error 400: redirect_uri_mismatch`.

**Google still stays out of the iOS binary after this.** Google blocks OAuth in
embedded WebViews (`disallowed_useragent`), so native Google needs
`ASWebAuthenticationSession` or the native SDK, not the Capacitor WebView. That
is a build, not a console change.

---

## 2. Apple — the one with real prerequisites

Needed for guideline 4.8 the moment ANY third-party sign-in ships inside the
binary. It is not needed today only because the OAuth block is hidden in native.

In the Apple Developer portal:

1. **Certificates, Identifiers & Profiles → Identifiers → your App ID**
   (`consulting.thenorth.houndstack`) → enable the **Sign in with Apple**
   capability.
2. **Identifiers → + → Services IDs.** Create one, e.g.
   `consulting.thenorth.houndstack.web`. This becomes the OAuth *client id*,
   and it is NOT the App ID — mixing the two is the usual first failure.
3. On that Services ID → **Configure**:
   - Domains: `api.houndstack.com`
   - Return URLs: `https://api.houndstack.com/auth/v1/callback`
4. **Keys → +** → enable Sign in with Apple → download the `.p8`. **It
   downloads once and never again.** Note the Key ID and your Team ID.
5. Supabase Dashboard → Authentication → Providers → Apple:
   - Client ID = the **Services ID** from step 2
   - Secret Key = the `.p8` contents, plus Team ID and Key ID

Apple's client secret is a JWT that **expires every 6 months**. Whoever sets
this up should put a calendar reminder in, because it fails silently — and it
fails exactly the way Google is failing now, at the provider, where the app
cannot see it. `npm run check:oauth` is what catches it.

---

## 3. Facebook — the one that needs a review

1. developers.facebook.com → Create App → type **Consumer**
2. Add the **Facebook Login** product
3. Facebook Login → Settings → **Valid OAuth Redirect URIs** →
   `https://api.houndstack.com/auth/v1/callback`
4. Settings → Basic → copy **App ID** and **App Secret** into Supabase
   Dashboard → Authentication → Providers → Facebook
5. Settings → Basic → add the **Privacy Policy URL**
   (`https://houndstack.com/legal/privacy`) — Facebook will not let the app go
   Live without it
6. Toggle the app from **Development** to **Live**. Until then only accounts
   with a role on the app can sign in, which means it will work for whoever
   tests it and fail for everybody else.

Point 6 is worth dwelling on: a Facebook app in Development mode passes every
check a developer can run on their own machine and fails for 100% of real
buyers. `npm run check:oauth` cannot see this one either — it is an
account-level distinction, not a redirect-URI one. Test it with an account that
has no role on the Meta app.

---

## Why the app could not catch the Google breakage

`oauthSignIn` in `src/routes/auth.tsx` already probes the authorize URL before
navigating, and treats `>= 400` as "provider not enabled". It is a good guard
and it was useless here, because **Supabase answered 302**. Supabase was fine.
The provider was enabled, configured, and redirecting happily. The failure was
one hop further on, at Google's domain, cross-origin and opaque to any check
the page can make about itself.

`scripts/check-oauth-providers.mjs` exists to make that hop. It:

1. reads `/auth/v1/settings` for what Supabase has switched on,
2. requests the authorize URL without following redirects,
3. **follows the `Location` to the provider and reads what the provider says.**

Step 3 is the one nothing else does — and the first version of that script got
it wrong in the identical way, by reading only the response body. Google does
not answer 400 with an error page; it answers **302** to
`accounts.google.com/signin/oauth/error` with the reason base64'd into an
`authError` parameter. Empty body, healthy-looking status. The script now
decodes that parameter.

### What the exit code means

The script fails (exit 1) only when a provider is **reachable and broken** —
a button a person can press that does not work. A provider that is switched on
at Supabase but has its button disabled is reported as a warning, because
nobody can reach it. Both directions of inconsistency are caught:

- switched on, broken at the provider, button live → **fail**
- switched off at Supabase, button live → **fail** (raw "Unsupported provider")
- switched on, broken, button disabled → warn
- switched off, button disabled → consistent

Both failing cases are mutation-tested: re-enabling the Google button makes it
exit 1, and so does making the Apple button live while Apple is off.
