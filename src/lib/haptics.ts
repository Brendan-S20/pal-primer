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

    // Prefer native Capacitor haptics when running inside the iOS/Android shell.
    // Dynamic import keeps the plugin out of the web bundle path.
    void import("@/lib/native").then(({ isNative, hapticImpact, hapticSuccess }) => {
      if (!isNative()) {
        const nav = window.navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
        nav.vibrate?.(PATTERNS[kind]);
        return;
      }
      if (kind === "success") void hapticSuccess();
      else if (kind === "error" || kind === "warning") void hapticImpact("heavy");
      else if (kind === "tap") void hapticImpact("light");
      else void hapticImpact("light");
    }).catch(() => {
      const nav = window.navigator as Navigator & { vibrate?: (p: number | number[]) => boolean };
      nav.vibrate?.(PATTERNS[kind]);
    });
  } catch {
    // vibration unsupported — silently ignore
  }
}
