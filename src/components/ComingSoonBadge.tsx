import type { ReactNode } from "react";

/**
 * The house "Coming soon" pill: the one the AI Receptionist and marketing
 * posts wear. A state, not an error: whatever it sits beside is switched off
 * on purpose and will light up on its own.
 *
 * `shrink-0` and `whitespace-nowrap` so it is never squeezed into two lines
 * beside a long label at 320px; the label wraps instead.
 */
export function ComingSoonBadge({
  children = "Coming soon",
  className = "",
}: {
  children?: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200 ${className}`}
    >
      {children}
    </span>
  );
}
