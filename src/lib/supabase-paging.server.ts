// BUG-23 — the silent 1000-row cap.
//
// PostgREST returns at most 1000 rows and says nothing about it. There is no
// error, no flag, no truncation notice: the query succeeds, the page renders,
// and the number is simply low. `/reports` was selecting EVERY invoice in the
// organization with no range and no paging, so past a thousand invoices its
// revenue, outstanding, aging and top-clients figures were all quietly wrong —
// and wrong in a way that gets worse the longer a business succeeds.
//
// That is the worst shape a data bug can take. Nothing looks broken, the
// failure arrives gradually, and the first person to notice is a customer who
// knows their own numbers better than we do.
//
// One helper, so a new query cannot forget.

const PAGE = 1000;

/**
 * Run a range-parameterised PostgREST query until it stops returning full
 * pages.
 *
 * `build(from, to)` must apply `.range(from, to)` and return the awaited
 * builder — everything else about the query is the caller's business.
 *
 *   const rows = await fetchAllPages<Row>((a, b) =>
 *     supabase.from("invoices").select("...").eq("organization_id", orgId)
 *       .order("created_at").range(a, b));
 *
 * ORDERING IS NOT OPTIONAL. Paging an unordered query is undefined: Postgres
 * may return rows in a different order per page, so a row can appear twice or
 * not at all. Callers order by a stable column.
 */
export async function fetchAllPages<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await build(offset, offset + PAGE - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    // A short page means the end. A full page means there may be more, even if
    // there isn't — one extra empty round-trip is the correct price for never
    // silently truncating.
    if (batch.length < PAGE) return out;
  }
}
