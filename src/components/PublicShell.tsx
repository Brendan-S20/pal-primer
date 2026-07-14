import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { cn } from "@/lib/utils";

/**
 * Shared shell for the public entry pages (/auth, /get-started, /sign-up,
 * /reset-password) so they all get the same treatment: landscape logo up top,
 * an optional tagline, and a soft brand-tinted backdrop.
 *
 * The backdrop is pure CSS (blurred primary-tinted glows), not an image, so it
 * costs nothing to load, works in light and dark themes, and never fights the
 * tenant brand accent. Color utilities only; no hsl(var()) interpolation,
 * which breaks against this project's oklch tokens.
 */
export function PublicShell({
  children,
  tagline,
  className,
}: {
  children: ReactNode;
  tagline?: string;
  className?: string;
}) {
  return (
    <div className="relative flex min-h-screen items-start justify-center overflow-hidden bg-background px-4 py-10 sm:items-center">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute -top-32 right-[-8%] h-96 w-96 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute bottom-[-12%] left-[-8%] h-[28rem] w-[28rem] rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute left-1/2 top-[-20%] h-72 w-[42rem] -translate-x-1/2 rounded-full bg-primary/5 blur-3xl" />
      </div>
      <div className={cn("relative w-full max-w-md space-y-6", className)}>
        <div className="flex flex-col items-center text-center">
          <Logo variant="landscape" className="h-9 text-primary" />
          {tagline && <p className="mt-3 text-sm text-muted-foreground">{tagline}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}
