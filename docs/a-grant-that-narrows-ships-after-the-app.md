# A grant that narrows ships after the app

How not to ship a grants migration that breaks My Day again. Written after
#492.

## What happened

`20261015215000_a-lock-box-code-is-for-the-assigned-day` revoked table SELECT
on `properties` from `authenticated` and granted back every column except the
access codes. It was applied to production at 11:59 AM ET on Oct 17. The
production frontend was an older build whose selects still named `gate_code`,
`lock_box_code` and `key_location`. PostgREST does not drop a column it may not
read. It refuses the whole request with 42501, "permission denied for table
properties". My Day, visit detail and the client properties tab all failed.
The app fix was already on `main` (8a344a86) but was not live.

The database moved before the app did. Nothing in CI ran the app's queries
against the narrowed grants, so nothing could have said so.

## The rule

A migration that takes a privilege away from `authenticated` or `anon` (a
`REVOKE`, a table grant replaced by a column grant, a function's EXECUTE
removed) ships in this order:

1. **The app stops using it first.** Merge the code that no longer selects the
   column or calls the function.
2. **That code is live.** Confirm the commit app.houndstack.com is serving, not
   the commit on `main`. Production is published from `main` through Lovable,
   and a merge is not a publish.
3. **Then apply the migration.** Never in the other order, and never in the
   same step as a deploy you have not confirmed.

A migration that only adds a privilege can go first. One that both adds and
removes follows the rule for removing.

A new column on a table that is already narrowed (`properties`,
`accounting_connections`) is withheld from signed-in users by default. Grant
it in the same migration, `GRANT SELECT (<column>) ON public.<table> TO
authenticated`, or list it as withheld on purpose.

## Before you apply it

- Search for every client-side read of what you are taking away:
  `rg -n -e gate_code -e lock_box_code -e key_location -e key_tag -e alarm_notes src`.
  Anything outside a service-role call site has to go first.
- Run `supabase db reset` and then `npm run test:db`. The DB test below runs
  the app's own selects against the grants your migration leaves.
- Say in the PR which deploy the migration waits for.

## What CI checks now

| Check                                                                              | Where it runs          | What it catches                                                                                                                                    |
| ---------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/a-browser-query-never-names-a-withheld-column.test.ts`                      | every PR               | a select anywhere in `src/` that names a withheld column, or `*` on a narrowed table, outside the listed service-role call sites                   |
| `tests/a-new-column-is-granted-or-withheld-on-purpose.test.ts`                     | every PR               | a migration that adds a column to a narrowed table without granting it, or that puts the table grant back                                          |
| `tests/integration/my-day-loads-under-the-narrowed-grants.db.test.ts`              | sandboxes database job | the My Day, visit detail and properties selects, read from the source, refused for the owner or the walker on a database built from the migrations |
| `supabase/proofs/20261029180000-a-narrowed-grant-withholds-only-what-it-names.sql` | sandboxes database job | the catalog withholding any column other than the listed ones, or reopening one of them                                                            |

The withheld columns are listed once in `tests/support/withheld-columns.ts`,
and again in the proof's `withheld:begin` block. The static test fails if the
two disagree. To withhold a new column, or narrow a new table, change both.

What none of this can check is which commit production is serving. That is
step 2 above, and it is a person's job.
