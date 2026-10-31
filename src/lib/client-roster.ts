// The /clients list's filters, totals and paging, worked out on the server
// (#617).
//
// The page used to receive every client and filter them in the browser. Past
// about a thousand clients that stopped working twice over: the aggregate
// reads behind the roster put every client id in a query string, which was
// refused as "URI too long", and PostgREST quietly returns at most a thousand
// rows. Now the server reads the roster org-wide, applies these filters, and
// sends one page.
//
// Pure, so the rules a filter applies are tested without a database.

import { clientMatchesQuery } from "@/lib/client-search";

export type RosterStatusFilter =
  | "all"
  | "active"
  | "inactive"
  | "outstanding"
  | "at_risk"
  | "no_plan";
export type RosterTypeFilter = "all" | "residential" | "commercial";

export type RosterFilters = {
  q?: string;
  status?: RosterStatusFilter;
  type?: RosterTypeFilter;
  tag?: string;
};

export type RosterRow = {
  id: string;
  display_name: string | null;
  account_type: string | null;
  primary_email: string | null;
  primary_phone: string | null;
  import_external_id?: string | null;
  active: boolean | null;
  churn_score: number | null;
  tags: string[] | null;
  street?: string | null;
  outstanding_cents: number;
  active_subscription_count: number;
};

/** A client marked active with no running service: never visited, invoiced
 *  or routed. Kept in one place so the tile, the filter and the rows agree. */
export function hasNoPlan(c: Pick<RosterRow, "active" | "active_subscription_count">): boolean {
  return !!c.active && (c.active_subscription_count ?? 0) === 0;
}

export function isAtRisk(c: Pick<RosterRow, "churn_score">): boolean {
  return (c.churn_score ?? 0) >= 60;
}

/** The rows a set of filters keeps, in roster order. */
export function filterRoster<T extends RosterRow>(rows: readonly T[], f: RosterFilters): T[] {
  const status = f.status ?? "all";
  const type = f.type ?? "all";
  const tag = f.tag && f.tag !== "all" ? f.tag.toLowerCase() : null;
  const q = (f.q ?? "").trim();
  return rows.filter((c) => {
    if (type !== "all" && c.account_type !== type) return false;
    if (tag && !(c.tags ?? []).some((t) => t.toLowerCase() === tag)) return false;
    if (status === "active" && !c.active) return false;
    if (status === "inactive" && c.active) return false;
    if (status === "outstanding" && !(c.outstanding_cents > 0)) return false;
    if (status === "at_risk" && !isAtRisk(c)) return false;
    if (status === "no_plan" && !hasNoPlan(c)) return false;
    return clientMatchesQuery(c, q);
  });
}

/** The tiles over the list: always the whole book, whatever is filtered. */
export function rosterStats(rows: readonly RosterRow[]) {
  let active = 0,
    outstanding = 0,
    owedTotal = 0,
    atRisk = 0,
    noPlan = 0;
  for (const c of rows) {
    if (c.active) active += 1;
    if (c.outstanding_cents > 0) outstanding += 1;
    owedTotal += c.outstanding_cents ?? 0;
    if (isAtRisk(c)) atRisk += 1;
    if (hasNoPlan(c)) noPlan += 1;
  }
  return { total: rows.length, active, outstanding, owedTotal, atRisk, noPlan };
}

/** Every tag in use, spelled as it was first seen, sorted. */
export function rosterTags(rows: readonly Pick<RosterRow, "tags">[]): string[] {
  const byLc = new Map<string, string>();
  for (const c of rows) {
    for (const t of c.tags ?? []) if (!byLc.has(t.toLowerCase())) byLc.set(t.toLowerCase(), t);
  }
  return [...byLc.values()].sort((a, b) => a.localeCompare(b));
}

/** Rows on one page of the list. */
export const CLIENTS_PAGE_SIZE = 50;
