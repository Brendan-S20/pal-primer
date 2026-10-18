// Reading and writing organizations.country before the column exists (#496).
//
// The app deploys on merge and 20261018120000 is applied after it, so for a
// while the code can ask for a column the database does not have yet. A
// select naming a missing column is not a partial answer, it is an error:
// Postgres raises 42703 ("column organizations.country does not exist") and
// PostgREST's schema cache answers a write with PGRST204 ("Could not find the
// 'country' column of 'organizations' in the schema cache"). loadMyOrg is
// asked by every signed-in page, so in that window every signed-in page broke.
//
// So the readers retry once without `country` and report it as null, which is
// "not set" and already falls back to the browser's region (distance-unit.ts).
// The writer retries once without it, so the rest of Settings > Business still
// saves. Only an error that names `country` is forgiven; anything else, and a
// second failure, still throws.
//
// Pure, no client imported: the caller passes the query in.

type MaybeError = { code?: unknown; message?: unknown } | null | undefined;

const MISSING_COLUMN_CODES = new Set(["42703", "PGRST204"]);

/** Is this the error a query gets for naming `country` before the column
 *  exists? Reads the code when there is one, and the message when there is
 *  not, because updateOwnOrg rethrows as a plain Error with the message only. */
export function isMissingCountryColumn(error: MaybeError): boolean {
  if (!error || typeof error !== "object") return false;
  const message = typeof error.message === "string" ? error.message : "";
  if (!/\bcountry\b/i.test(message)) return false;
  const code = typeof error.code === "string" ? error.code : "";
  if (MISSING_COLUMN_CODES.has(code)) return true;
  return /does not exist|could not find the .* column/i.test(message);
}

/** The same select list with `country` taken out. */
export function withoutCountry(columns: string): string {
  return columns
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c && c !== "country")
    .join(", ");
}

/** Run a select; if it failed only because `country` is not there yet, run it
 *  once more without it and answer `country: null`. */
// The callers' PostgREST builders are already `any` (the generated types lag
// the migration), so the row stays `any` here rather than inventing a shape.
export async function selectWithCountryFallback(
  columns: string,
  run: (columns: string) => PromiseLike<{ data: any; error: any }>,
): Promise<{ data: any; error: any }> {
  const first = await run(columns);
  if (!isMissingCountryColumn(first.error)) return first;
  console.warn("organizations.country is not on this database yet; reading without it");
  const retry = await run(withoutCountry(columns));
  return {
    data: retry.data ? { ...retry.data, country: null } : null,
    error: retry.error,
  };
}
