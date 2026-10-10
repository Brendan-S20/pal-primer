import { cn } from "@/lib/utils";

/**
 * A grey box where content will be. `hs-skeleton` (styles.css, SKELETONS)
 * pulses it, and holds it undrawn for its first 160ms so a load that answers
 * quickly never flashes grey: the box is laid out at once, so nothing moves
 * when the content replaces it, but it is only seen if the wait is real.
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("hs-skeleton rounded-md bg-primary/10", className)} {...props} />;
}

export { Skeleton };
