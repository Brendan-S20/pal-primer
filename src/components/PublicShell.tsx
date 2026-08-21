import type { ReactNode } from "react";
import { Logo } from "@/components/Logo";
import { PublicFooter } from "@/components/PublicFooter";
import { cn } from "@/lib/utils";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";

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
  // NATIVE ONLY — the flat px-4/py-10 below is the web product's spacing and
  // stays exactly as it was.
  //
  // Inside the binary that padding is not enough: below `sm` this shell is
  // `items-start`, and 2.5rem is less than the 59pt an iPhone with a Dynamic
  // Island reserves. iOS QA 2026-08-20 measured the wordmark rendering at
  // 20.7pt — underneath the clock, with the island over the middle of it. The
  // left/right insets matter in landscape, where the island takes a side.
  //
  // Applied as an inline style rather than Tailwind classes ON PURPOSE. New
  // arbitrary utilities would be emitted into the shared stylesheet even though
  // no web element could ever match them, so the hosted CSS would change to
  // carry rules for a platform it does not serve. An inline style emits no CSS
  // at all, and on the web this whole object is `undefined`.
  const nativeSafeArea = IS_NATIVE_BUNDLE
    ? {
        paddingTop: "calc(2.5rem + env(safe-area-inset-top))",
        paddingBottom: "calc(2.5rem + env(safe-area-inset-bottom))",
        paddingLeft: "calc(1rem + env(safe-area-inset-left))",
        paddingRight: "calc(1rem + env(safe-area-inset-right))",
      }
    : undefined;

  return (
    <div
      style={nativeSafeArea}
      className="relative flex min-h-screen items-start justify-center overflow-hidden bg-background px-4 py-10 sm:items-center"
    >
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
        {/* Legal/compliance links: Twilio verification expects the privacy
            policy and SMS consent disclosures reachable from the pages that
            collect phone numbers. */}
        <PublicFooter />
      </div>
    </div>
  );
}
