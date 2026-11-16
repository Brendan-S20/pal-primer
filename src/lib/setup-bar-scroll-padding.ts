// What /setup's sticky bar covers, as a scroll-padding-bottom (#946 follow-up).
// Measured and applied by SetupStepFooter; see the note there.

/** Room left above the bar, so a field never ends flush against its edge. */
export const SETUP_BAR_CLEARANCE_PX = 8;

/**
 * The page's scroll-padding-bottom while the bar is on screen: everything
 * the bar covers (its height, and the sticky offset it sits above, which is
 * the tab bar below `md`), plus a little clearance.
 */
export function setupBarScrollPadding(barHeight: number, stickyBottom: string): number {
  const offset = parseFloat(stickyBottom);
  return Math.ceil(barHeight + (Number.isFinite(offset) ? offset : 0)) + SETUP_BAR_CLEARANCE_PX;
}
