// What a page may show about "how many clients" on its first paint.
//
// ── WHY THIS EXISTS (onboarding QA, 2026-11-09, #790) ─────────────────────
//
// Right after the first client was saved, three surfaces showed numbers the
// server no longer held:
//
//   * /clients read "0 total · 0 active" in its header with the new client's
//     row listed under it. The summary query is held fresh for 60s, and the
//     page painted the copy it cached before the client existed while the
//     refetch was in flight. An import did not touch ["clients"] at all, so
//     after one the stale header could last the full minute.
//   * /dashboard painted the cached "0 active clients, $0.00 AR" and then
//     changed to "1 active client, $20.00 AR". Nothing that creates a client
//     (or its first-cleanup invoice) told ["dashboard-summary"] it had moved.
//   * The setup banner kept "Next: Add or import clients" on the client's
//     own page for as long as the onboarding refetch took.
//
// Invalidating is not enough for any of them: an invalidated query still
// RENDERS its cached data until the refetch lands, so the first paint is the
// old number and the second is the right one. These counts went from zero to
// not-zero; a zero we know is wrong is worse than a skeleton. So after the
// client book changes, the counts are RESET (cache dropped): the next paint
// is the loading state, and the one after it is the server's answer.

import type { QueryClient } from "@tanstack/react-query";
import { ONBOARDING_STATUS_KEY } from "@/hooks/useOnboardingStatus";

/** The /clients list and its header tiles: ["clients","summary"] and every
 *  ["clients","page",...]. */
export const CLIENTS_KEY = ["clients"] as const;
export const CLIENTS_SUMMARY_KEY = ["clients", "summary"] as const;
/** Active clients, AR open, collected MTD on the dashboard. */
export const DASHBOARD_SUMMARY_KEY = ["dashboard-summary"] as const;

/**
 * Call after anything that adds clients to the book (the new-client form, an
 * import commit). Drops every cached count that could now read low, and
 * refetches the ones on screen, so no surface paints a stale zero.
 */
export function afterClientBookChanged(qc: QueryClient): Promise<void> {
  return Promise.all([
    qc.resetQueries({ queryKey: CLIENTS_KEY }),
    qc.resetQueries({ queryKey: DASHBOARD_SUMMARY_KEY }),
    qc.resetQueries({ queryKey: ONBOARDING_STATUS_KEY }),
  ]).then(() => undefined);
}

/**
 * True when the /clients header tiles cannot be right: the list itself
 * matched more clients than the summary says the whole book holds. Every
 * filter narrows, so a consistent pair always has `matched <= total`.
 *
 * It catches what afterClientBookChanged cannot: a client added somewhere
 * that does not call it (another tab, another device, a teammate) inside the
 * summary's 60s staleTime. The page then shows the header's loading state and
 * refetches the summary, rather than "0 total" over a row.
 */
export function summaryLagsRows(
  summary: { stats?: { total?: number } | null } | null | undefined,
  page: { matched?: number; rows?: readonly unknown[] } | null | undefined,
): boolean {
  if (!summary || !page) return false;
  const total = summary.stats?.total ?? 0;
  const matched = Math.max(page.matched ?? 0, page.rows?.length ?? 0);
  return matched > total;
}
