# Mobile grooming first-customer QA

Derived from PR #477 at 3f453ebe, squashed onto main 99d7f209. The source PR is stacked on unmerged #478 and #476; this review branch carries those dependencies and does not rewrite the published source branch. Do not merge until dependency coordination and the checks below are complete.

## Launch switches

Grooming remains Coming soon. Pet waste stays bookable. A later launch PR must coordinate:

- `BOOKABLE_SERVICE_LINES` in `src/lib/service-lines.ts`: the owner picker, `serviceLinesAdditionProblem`, `customerMayBook`, `CUSTOMER_BOOKABLE_SERVICE_LINES`, `customerCanRequestService`, public catalog, portal request UI/server, public signup and receptionist all derive from this list.
- `public.bookable_service_lines()`: organization write guard and public catalog/quote/one-off SQL, plus `portal_request_groom`. No permanently false request constant remains.
- The assertions in `20261018150000` and its restoration `20261023190000` establish pet waste as the only bookable line at this point in migration history. A launch PR must add a later migration changing the SQL list and update the launch-gate tests; do not rewrite migrations already on main.
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

All added migrations follow main's latest timestamp, 20261018150000. The stacked dependency migrations were renumbered in their original order.

- `supabase/migrations/20261023120000_a-pet-can-be-a-cat.sql`
- `supabase/migrations/20261023120100_a-stay-is-a-sitters-booking.sql`
- `supabase/migrations/20261023120200_a-sitter-logs-what-each-pet-got.sql`
- `supabase/migrations/20261023120300_a-client-asks-for-a-stay.sql`
- `supabase/migrations/20261023120400_a-groom-is-timed-by-the-pets-size.sql`
- `supabase/migrations/20261023120500_a-vaccine-record-is-private.sql`
- `supabase/migrations/20261023120600_a-trainer-sells-a-package-of-sessions.sql`
- `supabase/migrations/20261023120700_a-groom-appointment-has-a-length.sql`
- `supabase/migrations/20261023120800_training-cancel-and-no-show.sql`
- `supabase/migrations/20261023120900_training-portal.sql`
- `supabase/migrations/20261023121000_grooming-repeat-stamp-start-time.sql`
- `supabase/migrations/20261023121100_grooming-portal.sql`
- `supabase/migrations/20261023121200_training-trainer-note-and-cancel-time.sql`
- `supabase/migrations/20261023121300_the-nightly-missed-lesson-has-a-reason.sql`
- `supabase/migrations/20261023121400_portal-reads-no-trainer-note.sql`
- `supabase/migrations/20261023121500_a-stay-can-change.sql`
- `supabase/migrations/20261023121600_a-stay-code-is-for-the-stays-sitter.sql`
- `supabase/migrations/20261023121700_a-sitter-knows-who-to-call.sql`
- `supabase/migrations/20261023121800_an-overnight-sitter-is-not-out-on-a-walk.sql`
- `supabase/migrations/20261023121900_a-holiday-is-not-a-closure.sql`
- `supabase/migrations/20261023122000_a-deposit-has-a-cancellation-rule.sql`
- `supabase/migrations/20261023122100_a-covering-sitter-sees-codes-on-their-days.sql`
- `supabase/migrations/20261023122200_a-kept-deposit-is-not-billed-twice.sql`
- `supabase/migrations/20261023122300_a-groom-that-was-not-done-bills-no-add-ons.sql`
- `supabase/migrations/20261023122400_two-grooms-cannot-share-a-groomer.sql`
- `supabase/migrations/20261023170000_grooming-skip-reasons.sql`
- `supabase/migrations/20261023180000_grooming-launch-defaults.sql`
- `supabase/migrations/20261023190000_keep-coming-soon-off-public-booking.sql`

`20261023180000` adds default seeding and setup review state; `20261023190000` restores main's public booking guard after older stacked function definitions.

## Required review before merge / launch

- Replay the entire migration history on an empty local/CI Supabase stack and run all integration tests, including private Storage.
- All CI impact, database, four-width and one-off browser jobs must be green on the final head.
- Review settings, office booking, Book this groom from Requests, My Day per-pet history/flags, ad hoc matting charge, vaccine expiry/proof, invoice/payment and the portal at 390/820/1024/1440.
- Exercise Cover with every replacement groomer busy: other work moves, the unplaceable groom stays visible, the owner gets client/date/time.
- Confirm existing pet waste signup, portal one-off booking, route generation, waste logging and invoicing still work.
- Controlled QA of the launch switch must show portal request -> Requests -> office booking -> groomer completion -> invoice/payment -> client portal, with other service-line switches unchanged.

## Explicitly deferred by the first-customer scope

Deposits and cancellation/no-show fees; real drive-time routing; van power/water; per-pet invoice lines; arbitrary-week repeats/rebook prompt; business-time-zone default date; groomer-only staff picker; a separate grooming board; Spanish/Chinese register and empty-state polish; dispatcher booking (#460); bank debit (#461). Track these before broader launch promises; none is silently represented as implemented.

- From Helm
