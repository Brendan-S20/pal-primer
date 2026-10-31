// The label each client gets in a picker (#429).
//
// The quote editor listed clients by display_name alone, so an org with two
// clients called "Harbor Point" showed two identical rows and nothing to
// choose between them. Each client is still one row; a name that more than
// one client has gets the street of that client's first property, and when
// that does not settle it either (same street, or none on file) the start of
// the client's id.

export type PickerClient = { id: string; display_name: string; street?: string | null };

const key = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** One row per client id, sorted by label, no two labels the same. */
export function clientPickerLabels<C extends PickerClient>(
  clients: readonly C[],
): Array<C & { label: string }> {
  const seen = new Set<string>();
  const unique = clients.filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)));

  const byName = new Map<string, number>();
  for (const c of unique)
    byName.set(key(c.display_name), (byName.get(key(c.display_name)) ?? 0) + 1);

  const withStreet = unique.map((c) => {
    const name = c.display_name.trim() || "Unnamed client";
    const street = (c.street ?? "").trim();
    const label =
      (byName.get(key(c.display_name)) ?? 0) > 1 && street ? `${name} · ${street}` : name;
    return { c, label };
  });

  const byLabel = new Map<string, number>();
  for (const r of withStreet) byLabel.set(key(r.label), (byLabel.get(key(r.label)) ?? 0) + 1);

  return withStreet
    .map(({ c, label }) => ({
      ...c,
      label: (byLabel.get(key(label)) ?? 0) > 1 ? `${label} · #${c.id.slice(0, 8)}` : label,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
