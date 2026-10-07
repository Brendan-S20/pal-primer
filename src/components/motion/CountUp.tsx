import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "@/lib/motion/reduced-motion";

/**
 * A number that counts up from zero the first time it is drawn, then simply
 * shows whatever it is given.
 *
 * Once per mount, never on an update: the dashboard refetches every minute,
 * and a figure that re-ran from zero each time would be a figure nobody
 * could read. Nothing at all under reduced motion, or for a zero.
 *
 * The span is `tabular-nums`, so the digits do not change width as they
 * tick: the card around it does not reflow, and nothing beside it moves.
 * Short (600ms) and ease-out, so the last digits settle rather than stop.
 */
export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  durationMs = 600,
}: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
}) {
  const [shown, setShown] = useState<number | null>(null);
  const played = useRef(false);
  const target = useRef(value);
  target.current = value;

  useEffect(() => {
    if (played.current) return;
    played.current = true;
    if (prefersReducedMotion() || !Number.isFinite(value) || value === 0) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      if (p < 1) {
        setShown(target.current * eased);
        raf = requestAnimationFrame(tick);
      } else {
        setShown(null);
      }
    };
    setShown(0);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      setShown(null);
    };
    // Once, on mount: later values are shown as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <span className="tabular-nums">{format(shown ?? value)}</span>;
}
