// Why a customer left, in a handful of answers that can be counted.
//
// Ending a service asked for a free-text reason ("Moving, cost, seasonal…"),
// stored it, and nothing ever read it back: there was no way to answer "why
// are people leaving?" short of opening every ended service. Sweep&Go's
// reports lead with exactly that question (persona review, 2026-09-27).
//
// New endings pick one of these; the detail goes in the notes. Reasons typed
// before this existed are sorted into the same buckets by the words they use,
// so the report covers the past too.

export const CHURN_REASONS = [
  "Moving away",
  "Price",
  "Service quality",
  "Doing it themselves",
  "Dog passed away or rehomed",
  "Seasonal",
  "Switched to another company",
  "Other",
] as const;

export type ChurnReason = (typeof CHURN_REASONS)[number];

const KEYWORDS: Array<[RegExp, ChurnReason]> = [
  [/\b(mov(e|ed|ing)|relocat|sold (the )?house|new (house|home))\b/i, "Moving away"],
  [/\b(price|cost|expensive|afford|budget|cheaper|money)\b/i, "Price"],
  [/\b(miss(ed)?|late|quality|poor|unhappy|complain|not clean|dirty|gate (left )?open)\b/i, "Service quality"],
  [/\b(myself|themselves|diy|own it|do it (our|my)sel)/i, "Doing it themselves"],
  [/\b(passed|died|put down|rehom|lost (the|our) dog|no (more )?dogs?)\b/i, "Dog passed away or rehomed"],
  [/\b(season|winter|snow|summer|pause)\b/i, "Seasonal"],
  [/\b(competitor|another company|other company|switch(ed)?|went with)\b/i, "Switched to another company"],
];

/** A stored reason, new or old, as one of CHURN_REASONS. */
export function churnReasonBucket(text: string | null | undefined): ChurnReason {
  const s = (text ?? "").trim();
  if (!s) return "Other";
  const exact = CHURN_REASONS.find((r) => r.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  for (const [re, r] of KEYWORDS) if (re.test(s)) return r;
  return "Other";
}

/** Counts per reason, most common first, only reasons that occurred. */
export function tallyChurnReasons(
  reasons: Array<string | null | undefined>,
): Array<{ reason: ChurnReason; count: number }> {
  const counts = new Map<ChurnReason, number>();
  for (const r of reasons) {
    const b = churnReasonBucket(r);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || CHURN_REASONS.indexOf(a.reason) - CHURN_REASONS.indexOf(b.reason));
}
