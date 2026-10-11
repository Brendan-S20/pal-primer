import { useEffect, useRef } from "react";
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
 * Short (450ms) and ease-out, so the last digits settle rather than stop.
 *
 * It writes the value of the span's own text node, frame by frame, and React
 * renders it exactly once. The node is React's: React rewrites it whenever
 * the value it renders changes, and is never surprised by a replaced child,
 * because the node is never replaced, only its value changed. It used to set state on every animation frame, which
 * re-rendered every KPI card on the dashboard sixty times a second for the
 * first 600ms after the data landed: the same moment the rest of the page
 * was rendering for the first time, on the same thread.
 */
export function CountUp({
  value,
  format = (n) => String(Math.round(n)),
  durationMs = 450,
}: {
  value: number;
  format?: (n: number) => string;
  durationMs?: number;
}) {
  const span = useRef<HTMLSpanElement>(null);
  const played = useRef(false);
  const latest = useRef({ value, format });
  latest.current = { value, format };

  useEffect(() => {
    if (played.current) return;
    played.current = true;
    const el = span.current?.firstChild;
    if (!el || prefersReducedMotion() || !Number.isFinite(value) || value === 0) return;
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - p, 3);
      const { value: target, format: fmt } = latest.current;
      el.nodeValue = fmt(p < 1 ? target * eased : target);
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    el.nodeValue = latest.current.format(0);
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.nodeValue = latest.current.format(latest.current.value);
    };
    // Once, on mount: later values are shown as they are.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <span ref={span} className="tabular-nums">
      {format(value)}
    </span>
  );
}
