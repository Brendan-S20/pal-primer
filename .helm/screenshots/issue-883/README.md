# Issue #883: adding services to an untouched starter catalog

The captures show Settings → Services after an owner starts with the untouched
`Pet waste removal` starter and uses **Add service** to create `Weekly scoop`,
then `One-time cleanup`. The starter row is absent; both owner-created rows remain.

- [390 px](services-after-add-390.png)
- [768 px](services-after-add-768.png)
- [1280 px](services-after-add-1280.png)

Reproduce with:

```sh
SWEEP_CHROMIUM=/usr/bin/chromium npx playwright test an-owner-replaces-the-untouched-default --workers=1
```

These are the real Settings UI with the repository's network-isolated browser
fixtures. The browser fixture supplies the post-write catalog; it does not execute
Postgres. Retirement and preservation rules are tested separately by
`tests/sql/an-owner-replaces-the-untouched-default.proof.sql` (run by the matching
Vitest database test when a local Postgres stack is available).
