# What still needs you

Everything in here needs a console, an account, a card, or a judgement call
that is not mine to make. Nothing in here can be done from the repo.

Ordered by what blocks the most. Last measured 2026-08-26 against `main`
(`76410a0`), deployed and live.

---

## 1. Sign in with Apple

**Blocks:** shipping any third-party sign-in inside the iOS binary
(guideline 4.8). Not blocking submission today, because the whole OAuth block
is hidden in the native build.

Supabase currently answers:

```json
{"error_code":"validation_failed","msg":"Unsupported provider: missing OAuth secret"}
```

The provider toggle is on. The credential is empty, and it is the one provider
where the toggle is not the credential: Apple hands you a `.p8` PRIVATE KEY,
and Supabase wants an ES256 **JWT signed with it**. Apple never shows you that
JWT, because it does not exist until somebody makes one.

You already have the key. **Key ID `JPRR76PFJX`.** What is missing:

- [ ] **Services ID.** Apple Developer → Identifiers → `+` → Services IDs.
      Something like `consulting.thenorth.houndstack.web`.
      **This is not the App ID.** The App ID identifies the iOS app; the
      Services ID identifies the web sign-in client, and Apple rejects the
      wrong one with `invalid_client` and no explanation.
- [ ] **Configure that Services ID** → domain `api.houndstack.com`,
      return URL `https://api.houndstack.com/auth/v1/callback`
- [ ] **Team ID** — top right of the Apple Developer portal, 10 characters
- [ ] Run it:

```
npm run apple:secret -- \
  --p8 /path/to/AuthKey_JPRR76PFJX.p8 \
  --team-id YOURTEAMID \
  --key-id JPRR76PFJX \
  --services-id consulting.thenorth.houndstack.web
```

- [ ] Paste the JWT into Supabase → Authentication → Providers → Apple →
      Secret Key. Client IDs field gets the **Services ID**.
- [ ] Run `npm run check:oauth`. It follows the redirect all the way to Apple
      and tells you whether it actually works, rather than whether it looks
      configured.

**Diarise the expiry.** Apple caps the token at 15,777,000 seconds, about six
months. When it lapses, Sign in with Apple stops — at Apple, invisible to the
app, exactly like the Google outage on 2026-08-25. The script prints the date.

---

## 2. Move the `.p8` out of the repo directory

- [ ] It is currently at the repo root. It is now gitignored, and it has never
      been committed, so nothing has leaked.

That key downloads from Apple **once** and cannot be re-fetched. Anyone holding
it can mint Sign in with Apple secrets for the team until it is revoked, so the
recovery is revoke, regenerate, re-sign — not "change a password". Keep it
somewhere else; `apple:secret` takes a path.

---

## 3. Delete the Xcode Cloud "Test" action

**Blocks:** clean Xcode Cloud builds.

- [ ] Xcode Cloud → the workflow → delete the Test action.

There is no API and no CLI for this. It has to be done in the UI, by you.

---

## 4. App Privacy questionnaire

**Blocks submission.**

- [ ] App Store Connect → App Privacy → complete it.

Nothing in the repo can answer it: it is a set of declarations about what the
app collects, and the person making the declaration has to be you.

---

## 5. Category mismatch

**Blocks submission review consistency.**

- [ ] Pick one. `docs/app-store-submission.md` says **Productivity**; App Store
      Connect currently says **Utilities**. Tell me which and I will make the
      doc agree, or change it in ASC yourself.

---

## 6. The demo workspace, before screenshots

- [ ] `brendancreataco@gmail.com` holds **owner** on the demo org. Keep or
      remove.
- [ ] Confirm the demo data is what you want photographed. It is currently
      3 technicians and 21 stops on a day, no real addresses, no gate codes,
      no customer detail.

Then I can regenerate the App Store screenshots. The existing 11 were for
choosing shots, not for submitting, and they predate today's UI.

---

## 7. Facebook sign-in — only if you want it

Not started, and nothing depends on it.

- [ ] Meta app (Consumer) → add Facebook Login
- [ ] Valid OAuth Redirect URI → `https://api.houndstack.com/auth/v1/callback`
- [ ] App ID + secret into Supabase
- [ ] Privacy Policy URL → `https://houndstack.com/legal/privacy`
- [ ] **Switch the app from Development to Live**

That last one is the trap. In Development mode it works for you and fails for
100% of buyers, and no automated check can see the difference — it is an
account-level distinction, not a redirect-URI one. Test it with an account that
has no role on the Meta app.

---

## Things you do NOT need to do

Listed so they stop taking up room.

| | state |
|---|---|
| Google sign-in | **live on the web**, verified against a real Google sign-in page |
| Account deletion (5.1.1(v)) | **live in production**, `authenticated`/`service_role` only |
| Auto-routing | **fixed and verified in production** — 21 stops split 8 / 7 / 6 |
| Routing panel | reduced to who / which days / Apply |
| Frequency repricing + visit-debit bounds | applied to production |
| Migration drift | in sync — 302 files, 276 applied, 201 functions declared |
| Deploy | `main` is live; `latest_commit_sha` matches |

---

## How to deploy, when you need to

`main` is deployed from Lovable. Merging alone does not ship anything.

A migration is different: it must be **applied to production separately**,
before the deploy that depends on it. Otherwise the code goes live calling a
function the database does not have. That gap was real for a few hours on
2026-08-25 with account deletion.
