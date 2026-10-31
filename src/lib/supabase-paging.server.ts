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

/**
 * fetchAllPages, but past the first page it asks for several pages at once.
 *
 * /clients at 5,000 clients is five full pages per table. One after another
 * that is six round trips before anything renders; this is three (the first
 * page, then pages 2-5 together, then the short one). A business under a
 * thousand rows still makes exactly one request, because nothing after the
 * first page is asked for until the first page comes back full.
 *
 * Same contract as fetchAllPages: `build` applies `.range(from, to)` and a
 * stable order.
 */
export async function fetchAllPagesConcurrently<T>(
  build: (from: number, to: number) => any,
  pagesAtOnce = 4,
): Promise<T[]> {
  const first = await build(0, PAGE - 1);
  if (first.error) throw new Error(first.error.message);
  const out: T[] = [...((first.data ?? []) as T[])];
  if (out.length < PAGE) return out;
  for (let page = 1; ; page += pagesAtOnce) {
    const wave = await Promise.all(
      Array.from({ length: pagesAtOnce }, (_, k) => {
        const from = (page + k) * PAGE;
        return build(from, from + PAGE - 1);
      }),
    );
    for (const { data, error } of wave) {
      if (error) throw new Error(error.message);
      const batch = (data ?? []) as T[];
      out.push(...batch);
      if (batch.length < PAGE) return out;
    }
  }
}

/**
 * How many uuids one GET may carry in an `.in()` filter.
 *
 * A uuid is 36 characters and PostgREST separates them with commas, so 40 of
 * them is about 1,500 characters: with the host, the select list and an org
 * filter, a request still stays under 2 KB. A list of every client id went
 * into one query string until #617, and at about a thousand clients the
 * request was refused as "URI too long", which emptied every client picker.
 */
export const IDS_PER_REQUEST = 40;

/** Split ids into groups small enough for one GET each. */
export function idChunks<T>(ids: readonly T[], size = IDS_PER_REQUEST): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
