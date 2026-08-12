import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";
import { DEFAULT_ORG_TIMEZONE, orgToday } from "@/lib/org-day";

/**
 * Today, in the organization's timezone, for components that render a date
 * judgement to a signed-in staff user.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 *
 * `isInvoiceOverdue(status, dueOn, today)` takes the day to compare against,
 * and its default is `America/Chicago` — the SQL column default, which
 * `org-day.ts` is explicit is a fallback and not an answer: "a caller that
 * does not know the timezone is a caller that should be fetching it, not
 * defaulting."
 *
 * `InvoiceRow` and `InvoiceDrawer` were calling it with two arguments, so they
 * took the default. `getDashboardSummary` reads `organizations.timezone` and
 * passes it. Both render the same invoices. For an organization east of
 * Central — and one of the live ones is `America/New_York` — that means an
 * invoice due today is badged **Overdue** on the invoice list from 23:00
 * Chicago time while the dashboard, which is asking the same question of the
 * same row, still counts it as current.
 *
 * The setting's own copy is the reason this is a bug rather than a detail.
 * Settings → Preferences says the timezone "decides what counts as 'today'
 * everywhere — the schedule, your clients' portal, overdue and missed-visit
 * detection". Two surfaces disagreeing for an hour a night is exactly what
 * that sentence promises will not happen.
 *
 * ── WHY A HOOK AND NOT A PROP ─────────────────────────────────────────────
 *
 * `InvoiceRow` renders inside two very different parents (the invoices index
 * and the client Billing tab) and `InvoiceCard` inside one of them. Threading
 * a `today` prop through each would mean every future consumer has to remember
 * to pass it, and forgetting silently reintroduces the same bug — the failure
 * mode this is fixing. Reading it here means a component cannot be wrong about
 * what day it is.
 *
 * It shares the `["my-org"]` query key with `useMyRole`, so this adds no
 * fetch: by the time an invoice renders, the shell has already loaded it.
 *
 * NOT for the portal. That is a different surface with no `getMyOrg` session;
 * portal-side day maths goes through the server, which already knows the org.
 */
export function useOrgToday(): string {
  const fn = useServerFn(getMyOrg);
  const { data } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  const tz =
    (data?.organization as { timezone?: string | null } | undefined)?.timezone ||
    DEFAULT_ORG_TIMEZONE;
  return orgToday(tz);
}
