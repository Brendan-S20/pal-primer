// The mapping step, column by column (2026-11-27).
//
// The owner looks at the file they exported, not at HoundStack's field list.
// So the mapping screen lists every column of the file, a few of its values,
// and where it will go: a field, or kept as a note on the record (never
// dropped, src/lib/import-leftovers.ts). The owner can change any of them
// before the preview. These are the pure halves of that screen: who reads a
// column, moving a column to a field, its sample values, and a suggested
// field for a column of a file HoundStack has no preset for.

export type ColumnMapping = Record<string, string | null>;

const norm = (s: string) => s.trim().toLowerCase();

/** The fields each column feeds, in the entity's field order. A column can
 *  feed two (Jobber's "Visit frequency" is how often and the service day). */
export function fieldsByColumn(
  mapping: ColumnMapping,
  headers: readonly string[],
  fieldOrder: readonly string[],
): Map<string, string[]> {
  const out = new Map<string, string[]>(headers.map((h) => [h, []]));
  for (const field of fieldOrder) {
    const col = mapping[field];
    if (!col) continue;
    const h = headers.find((x) => norm(x) === norm(col));
    if (h) out.get(h)!.push(field);
  }
  return out;
}

/** The mapping with `column` sent to `field`, or kept as a note when field
 *  is null. Sending a column to a field takes that field from whichever
 *  column fed it, and replaces the column's first field; any second field
 *  it fed is kept. Keeping it as a note clears every field it fed. */
export function assignColumn(
  mapping: ColumnMapping,
  column: string,
  field: string | null,
  fieldOrder: readonly string[],
): ColumnMapping {
  const next: ColumnMapping = { ...mapping };
  const mine = fieldOrder.filter((f) => next[f] && norm(next[f]!) === norm(column));
  if (field === null) {
    for (const f of mine) next[f] = null;
    return next;
  }
  if (mine[0] && mine[0] !== field) next[mine[0]] = null;
  next[field] = column;
  return next;
}

/** The mapping with one field let go of, the column kept for any other. */
export function dropField(mapping: ColumnMapping, field: string): ColumnMapping {
  return { ...mapping, [field]: null };
}

/** Up to `n` distinct non-blank values of a column, each cut to `max`
 *  characters, for the owner to recognise the column by. */
export function sampleValues(
  rows: readonly Record<string, unknown>[],
  column: string,
  n = 3,
  max = 40,
): string[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const v = r[column];
    if (v === undefined || v === null) continue;
    const s = String(v).replace(/\s+/g, " ").trim();
    if (!s || s === "-") continue;
    seen.add(s.length > max ? `${s.slice(0, max - 1)}…` : s);
    if (seen.size >= n) break;
  }
  return [...seen];
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Words too common to point a column at a field on their own: "Pet Name"
// is not the client's name, "Job type" is not the account type.
const TOO_COMMON = new Set([
  "name",
  "id",
  "type",
  "day",
  "date",
  "status",
  "total",
  "title",
  "client",
  "customer",
  "service",
  "plan",
  "notes",
  "note",
  "address",
  "street",
  "state",
  "tech",
  "staff",
  "source",
  "dogs",
  "pets",
]);

/** For a file whose columns no preset fully knows: the fields still unset,
 *  each pointed at a column no field reads yet whose name says it. A column
 *  is first matched by its whole name against every vendor's names for the
 *  field ("Cell Phone", "Zip Code"), then by containing one of them as words
 *  ("Client Email Address" contains "email"). Returns the fields it set;
 *  the owner sees each marked as suggested. */
export function suggestFields(
  mapping: ColumnMapping,
  headers: readonly string[],
  fieldOrder: readonly string[],
  namesByField: Record<string, readonly string[]>,
): { mapping: ColumnMapping; suggested: string[] } {
  const next: ColumnMapping = { ...mapping };
  const taken = new Set(
    Object.values(next)
      .filter((v): v is string => !!v)
      .map(norm),
  );
  const free = () => headers.filter((h) => h.trim() && !taken.has(norm(h)));
  const suggested: string[] = [];
  const take = (field: string, h: string) => {
    next[field] = h;
    taken.add(norm(h));
    suggested.push(field);
  };
  const open = fieldOrder.filter((f) => !next[f] && (namesByField[f]?.length ?? 0) > 0);
  for (const field of open) {
    const names = new Set(namesByField[field].map(words));
    const hit = free().find((h) => names.has(words(h)));
    if (hit) take(field, hit);
  }
  for (const field of open) {
    if (next[field]) continue;
    const names = [...new Set(namesByField[field].map(words))].filter(
      (n) => n.length >= 3 && !TOO_COMMON.has(n),
    );
    const hit = free().find((h) => {
      const w = ` ${words(h)} `;
      return names.some((n) => w.includes(` ${n} `));
    });
    if (hit) take(field, hit);
  }
  return { mapping: next, suggested };
}
