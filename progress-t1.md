# T1 progress

- Read CLAUDE.md, issue #413, design decisions, and walker plan/report/group/invoice patterns.
- Scope: office packages and session counts. Training remains Coming soon. No T2 notes/homework or T3 portal work.
- Database read rule: client_packages will reuse clients' may_read_client_row(organization_id, client_id), plus is_org_member. This gives office directory holders all clients and techs only their assigned clients.
- Plan: database guards and recount first, then server helpers, gated office UI and translated session badges, then unit/source and CI database tests.
- No migrations applied, no Supabase CLI, no dev servers, no commits.

- Added migration draft: catalog and sold-package snapshots, tenant/dog/invoice guards, serialized reservations, trigger-owned recount, package-plan price/cadence enforcement, request-id uniqueness and session numbering. Billing definition copied from supplied live SQL with only the two visit exclusions added.
- Checked current generate_prepaid_invoice: it refuses non-prepaid subscriptions. Package subscriptions are forced postpaid on insert and later pricing/cadence edits, so it needs no filter. Current billing wrappers call admin_generate_invoice_for_client. Ordinary postpaid visits still follow that function unchanged.
- Added server sale, weekly and one-time plan booking, listing, expiry extension and cancellation. Package visits use the existing plan-specific generator, with property dog counts and optional trainer assignment. Sales reuse manual invoice tax/card behavior and delete a losing invoice after package insert failure.
- Added inactive zero-price default package seed when training is selected, and changed the old package service seed to Evaluation (45 min).
- Added training-only Settings and client Services panels and translated session badge. Avoid-list edits so far: clients.$clientId.tsx, my-day.tsx and VisitDetailDrawer.tsx each have one import and one mount line. types.ts only adds package tables, links and helper signature. No changes to my-day.functions, visits.functions, clients.functions, offline, portal or reports.
- UI uses wrapping cards, one-column forms below sm, 44px selects, existing DateField/TimeField inputs. Browser viewport runs are excluded because this task forbids dev servers; static responsive checks will run.
