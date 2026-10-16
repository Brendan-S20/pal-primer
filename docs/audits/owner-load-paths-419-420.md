Owner dashboard, Plan & billing, and clients load-path review for #419 and #420.

The three supplied audit screenshots were inspected. This review traces the
checked-out source and runs the real handlers against delayed test queries.
Production elapsed times and EXPLAIN plans could not be collected: the executor
could not resolve app.houndstack.com, server credentials were not configured,
and SUPABASE_DB_URL was unset. The audit's 13 to 15 seconds and over 5 seconds
remain the reported baseline, not measurements reproduced in this workspace.

| Path | Before | After |
| --- | --- | --- |
| Dashboard revenue, after caller authorization | Org timezone, repeated org timezone, dispute preference, payments, then reversals: five serial read stages for one page per ledger | One org settings read, then payments and reversals together: two stages |
| Other month-to-date revenue callers | Timezone, dispute preference, payments, reversals | Combined settings, then both ledgers together |
| Billing browser | Status must finish before child sections mount and subscription items become enabled | Subscription items start with status; plans, methods, add-ons, and history prefetch on the first mount |
| Subscription details, after billing state | Stripe subscription, database plan catalog, Stripe price catalog | Three independent reads overlap |
| Saved cards, after customer validation | Subscription default, then card list | Default lookup and list overlap; subscription default still wins |
| Add-ons, after authorization | Catalog/membership/org, plan slug, founding eligibility | Founding eligibility overlaps catalog/membership/org; only plan slug depends on the org result |
| Clients | Roster, then three aggregate queries in parallel | Same four batched reads, with aggregate failures now propagated |

Caller authorization remains ahead of tenant data reads. No tenant-global cache
or permission shortcut was introduced. Dashboard financial reads still do not
run for roles without view_financials. Revenue paging, timezone boundaries,
tax subtraction, refunds, and dispute handling retain their existing rules.
Additional ledger pages and dispute-outcome queries still add necessary work.
No query-per-client or query-per-visit loop was found in these load paths.

Existing migration indexes cover the dashboard's organization/date visit query,
active clients, open invoices, and open concerns. Payments had an organization
index but no matching organization/date/id index. The review_items index puts
status before detected_at, while this read filters kind rather than status.
20261012130000_dashboard-ledger-date-indexes.sql adds organization/date/id
indexes for both paged ledger reads. It changes no data, policies, or billing
rules and was not applied to any database. Index build time, write overhead,
and planner choices require verification when the migration is deployed.

The display rule is that unknown data stays a skeleton. A successful response
may show a true zero or empty state. Cached successful data stays visible during
background refresh. Initial errors reach the existing route error boundary,
rather than becoming an empty account. Billing amounts also wait for live
subscription details before choosing monthly versus annual display. New
skeleton regions reuse common.loading, already available in en/es/ar/zh.

The tests in tests/owner-load-paths.test.ts execute the handlers and assert
query overlap, a single dashboard settings read, unchanged revenue arithmetic,
role gates, payment-method precedence, fixed query count for 112 clients, and
failure propagation. tests/owner-loading-states.test.ts renders the real page
components with pending, paused, successful-empty, populated, refreshing, and
failed query states. It also verifies billing prefetch registration before
status resolves. These are deterministic regression checks, not a claim about
production response times.

Billing charge, proration, subscription mutation, and card-removal logic were
not changed. The billing auto-refresh behavior and mutation invalidations were
preserved. Settings scheduling and SMS comments on #419 were outside this
request's dashboard/billing/clients scope. No prohibited files, URLs, routes,
or locale dictionaries were changed.
