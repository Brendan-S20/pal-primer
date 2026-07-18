// Pure domain logic for the DNA / units / stations commercial workstream
// (QA round 3 phase 6). Shared by the server functions AND the test suite so
// the linkage rules live in exactly one place (I3). No I/O here.

// ── Name / label validation (I11, mirrors the SQL is_valid_* functions) ──────

// Placeholders that slip past a plain length check. Kept in sync with
// is_valid_entity_name() / is_valid_label() (SQL) — the latest is the
// blacklist in 20260717210000_phase6-qa-fixes.sql ("na" was dropped: it's a
// plausible real short name, not junk).
const NAME_PLACEHOLDERS = new Set([
  "ew", "n/a", "tbd", "test", "asdf", "qwerty", "none", "null", "xxx",
  "xx", "unknown", "placeholder", ".", "-", "--", "...",
]);
const LABEL_PLACEHOLDERS = new Set([
  "na", "n/a", "tbd", "test", "asdf", "none", "null", "xxx", ".", "-", "--", "...",
]);

/**
 * A real entity NAME (dog, zone, promo): at least two characters, contains a
 * letter (so "1"/"01"/"12" are rejected), and is not a known placeholder.
 * Legitimate short names ("Bo", "Al", "Ax") pass.
 */
export function isValidEntityName(name: string | null | undefined): boolean {
  if (name == null) return false;
  const t = name.trim();
  if (t.length < 2) return false;
  // At least one letter in ANY script (rejects "1"/"01"/"12", allows CJK,
  // Cyrillic, accented Latin) — mirrors the SQL [[:alpha:]] check.
  if (!/\p{L}/u.test(t)) return false;
  if (NAME_PLACEHOLDERS.has(t.toLowerCase())) return false;
  return true;
}

/**
 * A real ORGANIZATION name (signup validation, I11 / H5 #4). Stricter than the
 * base entity check: also rejects names whose every word is a placeholder junk
 * token, which is how "Test Test" slipped past — each single word is "test"
 * (blocklisted) but the two-word name isn't an exact blocklist match.
 */
export function isValidOrgName(name: string | null | undefined): boolean {
  if (!isValidEntityName(name)) return false;
  const words = (name as string)
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => /\p{L}/u.test(w));
  if (words.length > 0 && words.every((w) => NAME_PLACEHOLDERS.has(w))) return false;
  return true;
}

export function assertValidOrgName(name: string | null | undefined): string {
  if (!isValidOrgName(name)) {
    throw new Error(
      "Enter your real business name (not blank or a placeholder like \"Test\").",
    );
  }
  return (name as string).trim();
}

/**
 * A real LABEL (unit / station descriptor): pure numbers are allowed ("101",
 * "B-12") but whitespace-only and placeholder junk are rejected.
 */
export function isValidLabel(label: string | null | undefined): boolean {
  if (label == null) return false;
  const t = label.trim();
  if (t.length < 1) return false;
  if (LABEL_PLACEHOLDERS.has(t.toLowerCase())) return false;
  return true;
}

/** Throwing wrapper for server functions — human-readable message (I11). */
export function assertValidDogName(name: string | null | undefined): string {
  if (!isValidEntityName(name)) {
    throw new Error(
      'Enter a real dog name (at least two characters, not a placeholder like "1" or "Ew").',
    );
  }
  return (name as string).trim();
}

export function assertValidUnitLabel(label: string | null | undefined): string {
  if (!isValidLabel(label)) {
    throw new Error("Enter a unit label (not blank or a placeholder).");
  }
  return (label as string).trim();
}

/**
 * A promo code is an entity name (I11): at least two characters INCLUDING a
 * letter, so a bare number like "10" is rejected (G8), but real codes such as
 * "SUMMER10" pass. Normalized to uppercase by the caller.
 */
export function assertValidPromoCode(code: string | null | undefined): string {
  if (!isValidEntityName(code)) {
    throw new Error(
      'Enter a real promo code with at least two characters including a letter (e.g. "SUMMER10"), not "10".',
    );
  }
  return (code as string).trim();
}

// ── Dog → property → unit linkage / reconciliation (I5, I9) ──────────────────

export type DogLinkageInput = {
  unitId: string | null | undefined;
  /** True when the dog's property has at least one unit. */
  propertyHasUnits: boolean;
};

/**
 * Whether a dog needs management review: it lives on a property that HAS units
 * but is not assigned to one. Never guesses a unit (I5). Assigned dogs, and
 * dogs on unit-less properties, are fine.
 */
export function dogNeedsUnitReview(input: DogLinkageInput): boolean {
  return !input.unitId && input.propertyHasUnits;
}

// ── Sample → unit / responsible party match (I13 #15) ────────────────────────

export type MatchDogRecord = {
  id: string;
  name: string | null;
  unitId: string | null;
  propertyId: string | null;
  clientId: string | null;
  residentName?: string | null;
};

export type ResponsibleParty = {
  dogId: string;
  dogName: string | null;
  unitId: string | null;
  propertyId: string | null;
  clientId: string | null;
  /** Who the violation notice / fine is attributed to. */
  responsible: string;
  /** True when the match resolved to a specific unit (else property-level). */
  unitResolved: boolean;
};

/**
 * Resolve a matched pile sample to the responsible party via the authoritative
 * chain Lab result → Dog → Unit → responsible party (I9). Falls back to the
 * resident/household on the unit, then the property/client.
 */
export function resolveResponsibleParty(dog: MatchDogRecord): ResponsibleParty {
  const responsible =
    dog.residentName?.trim() ||
    dog.name?.trim() ||
    "Unassigned resident";
  return {
    dogId: dog.id,
    dogName: dog.name,
    unitId: dog.unitId,
    propertyId: dog.propertyId,
    clientId: dog.clientId,
    responsible,
    unitResolved: !!dog.unitId,
  };
}

// ── Station numbering (I4, I13 #20) ──────────────────────────────────────────

/** Next stable integer for a property's stations: max + 1, starting at 1. */
export function nextStationNumber(existingNumbers: Array<number | null | undefined>): number {
  const nums = existingNumbers.filter((n): n is number => typeof n === "number" && n > 0);
  return nums.length ? Math.max(...nums) + 1 : 1;
}

/** Renumber a set of stations to a clean 1..n sequence, preserving order. */
export function renumberStations<T extends { sortOrder?: number | null; stationNumber?: number | null; createdAt?: string }>(
  stations: T[],
): Array<T & { stationNumber: number }> {
  const ordered = [...stations].sort((a, b) => {
    const ao = a.sortOrder ?? a.stationNumber ?? 0;
    const bo = b.sortOrder ?? b.stationNumber ?? 0;
    if (ao !== bo) return ao - bo;
    return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
  });
  return ordered.map((s, i) => ({ ...s, stationNumber: i + 1 }));
}

/** Human station name: "Station 3 · Building A" (number is the stable id). */
export function stationDisplayName(stationNumber: number | null | undefined, label: string | null | undefined): string {
  const num = typeof stationNumber === "number" && stationNumber > 0 ? `Station ${stationNumber}` : null;
  const desc = label?.trim() || null;
  if (num && desc) return `${num} · ${desc}`;
  return num ?? desc ?? "Station";
}

// ── Per-station service history (I13 #20) ────────────────────────────────────

export type StationServiceLog = { wasteStationId: string; servicedAt: string };

/** Most-recent serviced date per station id from a flat list of logs. */
export function lastServicedByStation(logs: StationServiceLog[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const l of logs) {
    const cur = out[l.wasteStationId];
    if (!cur || l.servicedAt > cur) out[l.wasteStationId] = l.servicedAt;
  }
  return out;
}
