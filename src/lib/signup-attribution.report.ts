// Turning captured signup UTM payloads into an answer.
//
// ── WHY THIS EXISTS ────────────────────────────────────────────────────────
//
// `organizations.signup_utm` has been written by bootstrap_organization since
// 2026-07-14 and read by nothing: no report, no metric, no query. The
// dead-machinery check calls that out, and its stated remedy is "surface it or
// stop storing it".
//
// Surface it. The capture is deliberate and correct — signup-attribution.ts
// carries the five UTM parameters through the whole signup walkthrough,
// including the OAuth detour that would otherwise lose them — and it is about
// to matter, because the marketing site is what will drive signups. Deleting a
// working capture path immediately before it has anything to capture would be
// the wrong half of that choice.
//
// Worth recording: the check's own note said this was "attribution data
// collected since 2026-07-14 that no one can see". It is not. Zero
// organizations hold a `signup_utm` payload — nobody has yet signed up through
// a tagged link. So there is no unread pile of data and no privacy exposure
// today; there is a writer with no reader, which is a smaller problem with the
// same fix.
//
// ── THE QUESTION THIS ANSWERS ──────────────────────────────────────────────
//
// Not "how many signups did this campaign bring", which flatters every
// channel that produces tyre-kickers, but "how many PAYING customers". A
// campaign with forty signups and no conversions is a campaign to stop
// funding, and a source-count table alone cannot tell you that. So every row
// carries both, and sorts on the one that pays for itself.

/** The UTM keys signup-attribution.ts captures, in the order a report reads
 *  best. Kept here as a list so an unknown sixth key cannot silently vanish. */
export const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;
export type UtmKey = (typeof UTM_KEYS)[number];

export type AttributedOrg = {
  /** The raw jsonb captured at signup; null for a direct signup. */
  signup_utm: Record<string, unknown> | null;
  /** Whether this organization ever became a paying customer. */
  converted: boolean;
};

export type AttributionRow = {
  /** The value of the grouped key, or null for signups that carried none. */
  value: string | null;
  signups: number;
  converted: number;
  /** Whole percent, or null when there are no signups to divide by. */
  conversionPercent: number | null;
};

/** Statuses that mean this organization is, or has been, paying us.
 *
 *  Deliberately includes past_due and canceled: a campaign that produced a
 *  customer who later churned still produced a customer, and scoring it as a
 *  failure would push spend toward whichever channel happens to have the
 *  freshest cohort. */
const CONVERTED_STATUSES = new Set(["active", "past_due", "grace", "canceled"]);

export function orgHasConverted(planStatus: string | null | undefined): boolean {
  return CONVERTED_STATUSES.has((planStatus ?? "").trim().toLowerCase());
}

function readKey(utm: Record<string, unknown> | null, key: UtmKey): string | null {
  if (!utm) return null;
  const raw = utm[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  // An empty parameter (`?utm_source=`) is not a source. Treating it as one
  // would create a phantom channel that nothing can be attributed to.
  return trimmed === "" ? null : trimmed;
}

/**
 * Group organizations by one UTM parameter.
 *
 * Rows with no value for that key collapse into a single `null` row rather
 * than being dropped — the count of signups that arrived untagged is the
 * denominator for everything else, and hiding it makes every campaign look
 * more significant than it is.
 */
export function groupByUtm(orgs: readonly AttributedOrg[], key: UtmKey): AttributionRow[] {
  const buckets = new Map<string | null, { signups: number; converted: number }>();
  for (const org of orgs) {
    const value = readKey(org.signup_utm, key);
    const bucket = buckets.get(value) ?? { signups: 0, converted: 0 };
    bucket.signups += 1;
    if (org.converted) bucket.converted += 1;
    buckets.set(value, bucket);
  }

  return [...buckets.entries()]
    .map(([value, b]) => ({
      value,
      signups: b.signups,
      converted: b.converted,
      conversionPercent: b.signups > 0 ? Math.round((b.converted / b.signups) * 100) : null,
    }))
    .sort((a, b) => {
      // Untagged always last, however large: it is context, not a channel, and
      // letting it head the table buries the thing the page is for.
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      // Paying customers first, then volume, then name for a stable order.
      if (b.converted !== a.converted) return b.converted - a.converted;
      if (b.signups !== a.signups) return b.signups - a.signups;
      return a.value.localeCompare(b.value);
    });
}

/** Does any organization carry attribution at all? Drives an honest empty
 *  state — "nothing has come through a tagged link yet" is a different message
 *  from "no data", and only one of them tells someone to go and tag a link. */
export function hasAnyAttribution(orgs: readonly AttributedOrg[]): boolean {
  return orgs.some((o) => UTM_KEYS.some((k) => readKey(o.signup_utm, k) !== null));
}
