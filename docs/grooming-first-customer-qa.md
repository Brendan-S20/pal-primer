# Mobile grooming first-customer QA

Rebased onto main 90746c65 after training #476 merged. Main supplies the current training implementation; the six stale training migration copies were dropped. Sitting dependencies from #478 remain pending that PR. Do not merge until dependency coordination and the checks below are complete.

## Launch switches

Grooming remains Coming soon. Pet waste stays bookable. A later launch PR must coordinate:

- `BOOKABLE_SERVICE_LINES` in `src/lib/service-lines.ts`: the owner picker, `serviceLinesAdditionProblem`, `customerMayBook`, `CUSTOMER_BOOKABLE_SERVICE_LINES`, `customerCanRequestService`, public catalog, portal request UI/server, public signup and receptionist all derive from this list.
- `public.bookable_service_lines()`: organization write guard and public catalog/quote/one-off SQL, plus `portal_request_groom`. No permanently false request constant remains.
- The assertions in `20261018150000` and its restoration `20261024100900` establish pet waste as the only bookable line at this point in migration history. A launch PR must add a later migration changing the SQL list and update the launch-gate tests; do not rewrite migrations already on main.
- `PORTAL_VACCINE_UPLOADS_ENABLED` stays false independently of booking. Enable only after the Storage suite passes in CI: office access, cross-client isolation, MIME/type and size limits. Both server upload steps refuse while disabled; clients can still read their own existing records.

## Review disposition

- Repeats: preserve plan duration, start time, pet selection, price, summary and add-ons on every generated visit; existing DB test covers day 0, 126 and 336.
- Overlap: preserve server checks for book/move/reassign/bulk/weather and the database trigger that serializes each groomer/day. Cover tries other staff and leaves unplaceable appointments where they were. Office sees client/day/time; owner gets an in-app notice.
- Billing reversal: preserve void/refund/refuse-invoiced behavior when a completed groom becomes missed or reopens, with pending, credit and invoiced DB cases.
- Vaccine launch path: office records expiry and Proof seen; unchecked proof warns. My Day evaluates the appointment date. Portal upload implementation remains present, ownership-scoped and hidden behind a separate release switch.
- Buffer: default 30 minutes, labeled Setup, cleanup and travel minutes; existing configured buffer values are preserved.
- Setup: newly enabled grooming businesses get Full groom and Bath and tidy, each with priced S/M/L/XL fallback rules for every coat. Inserts ignore existing prices. The pricing checklist step links to Services to review the grid, vaccine rule and buffer; saving settings marks review complete.
- Wording: grooming skip labels in en/es/ar/zh, Requests inbox, corrected Arabic quote label, neutral shared terms, notes, photo/access labels, hazards and expenses for non-pet-waste workers. Pet waste retains its own labels and picker.
- Access: grooming code never selects gate/lockbox fields; existing regression guard preserved. Shared My Day retains main's scoped access-code path.
- One service-line addition helper, `serviceLinesAdditionProblem`. Preserve all existing qc_tickets categories, including training requests.

## Migration files (never applied to a live database)

The ten grooming migrations use 20261024100000–20261024100900, after main’s latest 20261023150000. Sitting dependencies retain their existing versions. The shared pet prerequisite at 20261023120000 still collides with main’s training portal version pending permission to renumber that sitting file.

- `supabase/migrations/20261023120000_a-pet-can-be-a-cat.sql`
- `supabase/migrations/20261023120100_a-stay-is-a-sitters-booking.sql`
- `supabase/migrations/20261023120200_a-sitter-logs-what-each-pet-got.sql`
- `supabase/migrations/20261023120300_a-client-asks-for-a-stay.sql`
- `supabase/migrations/20261024100000_a-groom-is-timed-by-the-pets-size.sql`
- `supabase/migrations/20261024100100_a-vaccine-record-is-private.sql`
- `supabase/migrations/20261024100200_a-groom-appointment-has-a-length.sql`
- `supabase/migrations/20261024100300_grooming-repeat-stamp-start-time.sql`
- `supabase/migrations/20261024100400_grooming-portal.sql`
- `supabase/migrations/20261023121500_a-stay-can-change.sql`
- `supabase/migrations/20261023121600_a-stay-code-is-for-the-stays-sitter.sql`
- `supabase/migrations/20261023121700_a-sitter-knows-who-to-call.sql`
- `supabase/migrations/20261023121800_an-overnight-sitter-is-not-out-on-a-walk.sql`
- `supabase/migrations/20261023121900_a-holiday-is-not-a-closure.sql`
- `supabase/migrations/20261023122000_a-deposit-has-a-cancellation-rule.sql`
- `supabase/migrations/20261023122100_a-covering-sitter-sees-codes-on-their-days.sql`
- `supabase/migrations/20261023122200_a-kept-deposit-is-not-billed-twice.sql`
- `supabase/migrations/20261024100500_a-groom-that-was-not-done-bills-no-add-ons.sql`
- `supabase/migrations/20261024100600_two-grooms-cannot-share-a-groomer.sql`
- `supabase/migrations/20261024100700_grooming-skip-reasons.sql`
- `supabase/migrations/20261024100800_grooming-launch-defaults.sql`
- `supabase/migrations/20261024100900_keep-coming-soon-off-public-booking.sql`

`20261024100800` adds default seeding and setup review state; `20261024100900` restores main's public booking guard after older stacked function definitions.

## Required review before merge / launch

- Replay the entire migration history on an empty local/CI Supabase stack and run all integration tests, including private Storage.
- All CI impact, database, four-width and one-off browser jobs must be green on the final head.
- Review settings, office booking, Book this groom from Requests, My Day per-pet history/flags, ad hoc matting charge, vaccine expiry/proof, invoice/payment and the portal at 390/820/1024/1440.
- Exercise Cover with every replacement groomer busy: other work moves, the unplaceable groom stays visible, the owner gets client/date/time.
- Confirm existing pet waste signup, portal one-off booking, route generation, waste logging and invoicing still work.
- Controlled QA of the launch switch must show portal request -> Requests -> office booking -> groomer completion -> invoice/payment -> client portal, with other service-line switches unchanged.

## Rebase verification (October 24)

- Main: `90746c65`, including merged training #476. Training-only source and migrations now come from main; 29 source/test files are byte-identical to main. The training launch fixture was adapted to the shared booking gate.
- All 12 sitting migrations remain byte-identical to the original #535 head. None is an exact duplicate on main. The shared `20261023120000_a-pet-can-be-a-cat.sql` still collides with main's training portal version; changing that sitting prerequisite needs an exception to the current task's sitting restriction.
- Clean `npm ci`, TypeScript (6 GB heap), and `check:hooks` passed locally. CI typecheck also passed.
- Full Vitest: 7,999 passed, 316 skipped. The duplicate-version and training-portal ordering checks fail on the retained sitting prerequisite. The full run also loaded an earlier catalog fixture expectation; that expectation now preserves main's package-only training policy and its focused rerun passed.
- Focused final scope/catalog checks: 38 passed. Named wording check: **groomer wording has neutral term fallbacks, expenses, access and hazards**. This covers translation values, grooming checklist and shared UI guards; it is not a real-database browser walkthrough.
- CI database replay reproduced `schema_migrations_pkey` duplicate version `20261023120000`. The checkout infrastructure failure recovered on retry. The verification runner also lost `node_modules/vitest/suppress-warnings.cjs` mid-run; no CI gates were weakened.
- No live database migrations or real payment walkthrough performed. Grooming remains Coming soon and portal vaccine uploads remain disabled.

## Historical pre-rebase verification

- TypeScript: `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit` passed. Node's default 2 GB heap was insufficient.
- Browser fixtures: grooming settings and the My Day matting charge passed at 390, 820, 1024 and 1440. The phone case passed on rerun after allowing for Vite's cold module load. These are fixture UI checks, not real payment or database integration tests.
- Full lint: 16,934 errors and 155 warnings. 5,924 errors are in 616 files unchanged by this PR. This is the existing baseline; CI gates on check:hooks. No lint rules were disabled.
- Local Supabase replay/Storage: blocked before startup by the environment denying the public.ecr.aws image pull. Portal uploads remain disabled.
- Remote CI: checkout failed on the self-hosted runner with a missing `_runner_file_commands/set_output_*` file, including a retry. DB/browser/impact jobs did not reach application checks.
- Full Vitest results are recorded in the PR body after the final run.

The screenshots below use synthetic fixture data, including the fixture's trial banner and checklist. They show the new controls and billing confirmation; QA must still review a real grooming setup with its own checklist and current billing state.

[Settings at 390px](grooming-qa/setup-390.png) · [Matting confirmation at 390px](grooming-qa/matting-390.png)

## Explicitly deferred by the first-customer scope

Deposits and cancellation/no-show fees; real drive-time routing; van power/water; per-pet invoice lines; arbitrary-week repeats/rebook prompt; business-time-zone default date; groomer-only staff picker; a separate grooming board; Spanish/Chinese register and empty-state polish; dispatcher booking (#460); bank debit (#461). Track these before broader launch promises; none is silently represented as implemented.

- From Helm
