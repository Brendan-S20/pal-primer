// The timeline recorded exactly what changed and showed only that something had.
//
// `logActivity` takes a free-form `meta`, and the callers that describe an EDIT
// fill it with a field-level diff — `clients.functions.ts` writes
// `{ fields, before, after }`, `properties.functions.ts` writes `before`/`after`
// objects for an address change and for a price change driven by a unit-count
// change. `ActivityTab` rendered `e.summary` and nothing else, so "Updated
// client name, email, phone" was the whole story: three fields named, none of
// their values, on the screen whose entire job is answering "what happened to
// this client".
//
// ── WHAT IS DELIBERATELY NOT SHOWN ────────────────────────────────────────
//
// A uuid. `zone.detected` writes `{ before: <zone id>, after: <zone id> }`, and
// "Zone changed from 7f3a1c94-… to 91b2e0af-…" is worse than the summary alone:
// it is longer, it looks like detail, and it carries nothing a person can act
// on. Resolving those ids to names would mean a join per timeline entry against
// tables the row does not reference. So a value that is a uuid drops its line,
// and if that empties the diff the entry renders exactly as it did before.
//
// Same reasoning, less obviously: a field whose before and after are equal is
// dropped. `clients.functions.ts` builds its diff from the whole patch, and a
// form that submits every field posts unchanged ones too.

/** One field that actually moved. */
export type ActivityChange = {
  field: string;
  label: string;
  before: string;
  after: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Keys that are bookkeeping rather than anything a person changed. */
const SKIP_FIELDS = new Set(["updated_at", "created_at", "organization_id", "id", "impersonation"]);

const LABEL_OVERRIDES: Record<string, string> = {
  postal_code: "ZIP",
  price_cents: "Price",
  unit_count: "Units",
  total_units: "Units",
  email: "Email",
  phone: "Phone",
};

export function fieldLabel(field: string): string {
  if (LABEL_OVERRIDES[field]) return LABEL_OVERRIDES[field];
  const words = field
    .replace(/_cents$/, "")
    .replace(/_id$/, "")
    .split("_");
  const first = words[0] ?? field;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...words.slice(1)].join(" ");
}

/**
 * A value as a person reads it. Returns null for anything that should take its
 * whole line with it — a uuid, or a value with no readable form.
 */
export function formatActivityValue(field: string, value: unknown): string | null {
  if (value === null || value === undefined || value === "") return "not set";
  if (typeof value === "boolean") return value ? "yes" : "no";
  if (typeof value === "number") {
    if (field.endsWith("_cents")) {
      return `$${(value / 100).toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })}`;
    }
    return String(value);
  }
  if (typeof value === "string") {
    if (UUID.test(value)) return null;
    const trimmed = value.trim();
    if (!trimmed) return "not set";
    return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed;
  }
  // Arrays and nested objects: no honest one-line form, so no line.
  return null;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * The changes behind a timeline entry, or an empty list when the entry carries
 * none that can be shown.
 *
 * Three shapes are understood, because three shapes are written:
 *   - `{ before: {…}, after: {…} }`  — the field-level diff (client edits,
 *     address changes, price changes)
 *   - `{ before: x, after: y }`      — a single value, labelled from the kind
 *   - `{ from: x, to: y }`           — the same thing under different names
 *     (`visit.rescheduled`, the zone re-detect job)
 *
 * Anything else returns nothing rather than a guess. `meta` is
 * `Record<string, unknown>` by design and most writers put unrelated
 * bookkeeping in it — `request_id`, `visit_id`, `review_kind` — which is not a
 * diff and must not be rendered as one.
 */
export function activityChanges(meta: unknown, kind?: string | null): ActivityChange[] {
  if (!isPlainObject(meta)) return [];

  const pair =
    "before" in meta || "after" in meta
      ? { before: meta.before, after: meta.after }
      : "from" in meta || "to" in meta
        ? { before: meta.from, after: meta.to }
        : null;
  if (!pair) return [];

  // Shape 1: two objects keyed by field name.
  if (isPlainObject(pair.before) || isPlainObject(pair.after)) {
    const before = isPlainObject(pair.before) ? pair.before : {};
    const after = isPlainObject(pair.after) ? pair.after : {};
    const fields = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const out: ActivityChange[] = [];
    for (const field of fields) {
      if (SKIP_FIELDS.has(field)) continue;
      const b = formatActivityValue(field, before[field]);
      const a = formatActivityValue(field, after[field]);
      if (b === null || a === null) continue;
      if (b === a) continue;
      out.push({ field, label: fieldLabel(field), before: b, after: a });
    }
    return out;
  }

  // Shape 2: a single value. The field name has to come from the kind, since
  // the meta does not carry one — "zone.detected" → "Zone".
  const field = (kind ?? "").split(".")[0] || "value";
  const b = formatActivityValue(field, pair.before);
  const a = formatActivityValue(field, pair.after);
  if (b === null || a === null || b === a) return [];
  return [{ field, label: fieldLabel(field), before: b, after: a }];
}
