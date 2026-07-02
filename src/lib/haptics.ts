// Lightweight haptics wrapper. No-ops when the browser lacks vibration or the
// user prefers reduced motion. Duration values are tuned for a native-feeling
// tap without buzzing through pockets.
type Pattern = "tap" | "success" | "warning" | "error" | "select";

const PATTERNS: Record<Pattern, number | number[]> = {
  tap: 8,
  select: 4,
  success: [10, 40, 10],
  warning: [20, 60, 20],
  error: [30, 60, 30, 60, 30],
};

export function haptic(kind: Pattern = "tap") {
  if (typeof window === "undefined") return;
  try {
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;
    const nav = window.navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
    nav.vibrate?.(PATTERNS[kind]);
  } catch {
    // vibration unsupported — silently ignore
  }
}
