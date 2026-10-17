// How full the setup progress bar is.
//
// The phone bar on /setup was filled by POSITION, (index + 1) / steps, so on
// the last step it read 100% while the line above it said "3 of 6 done" (QA
// row 42). The bar now says what the sentence says: the share of steps done.
// It reads full only when every step is done.

export function setupProgressPct(steps: ReadonlyArray<{ done: boolean }>): number {
  if (steps.length === 0) return 0;
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return 100;
  // Rounded down, so a nearly finished list can never round up to a full bar.
  return Math.floor((done / steps.length) * 100);
}
