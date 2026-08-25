import markSvg from "@/assets/houndstack-mark.svg?raw";
import wordmarkSvg from "@/assets/houndstack-wordmark.svg?raw";
import logoSvg from "@/assets/houndstack-logo.svg?raw";
import { cn } from "@/lib/utils";

type Variant = "mark" | "wordmark" | "logo" | "landscape";

const SOURCES: Record<Exclude<Variant, "landscape">, string> = {
  mark: markSvg,
  wordmark: wordmarkSvg,
  logo: logoSvg,
};

interface LogoProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

/**
 * Inline HoundStack logo. All fills are `currentColor`, so the surrounding
 * `text-*` class controls the color. Use `text-primary` on light surfaces
 * (renders as the brand navy) and `text-white` / `text-primary-foreground`
 * on dark surfaces.
 *
 * Variants: `mark` (icon only), `wordmark` (text only, wide), `logo`
 * (stacked mark-over-wordmark), `landscape` (mark beside wordmark, for
 * horizontal spaces like sign-in headers). The height class you pass sets
 * the overall size; width follows the artwork's aspect.
 */
export function Logo({ variant = "mark", className, ...rest }: LogoProps) {
  if (variant === "landscape") {
    // The wordmark already carries the dog-in-H motif as its first letter, so
    // it IS the horizontal lockup; pairing it with the mark doubles the dog.
    // The explicit aspect ratio (from the tight-cropped viewBox) makes the
    // span reserve the real width for the artwork.
    return (
      <span
        aria-hidden
        className={cn(
          // max-w-full because the wordmark is sized from its HEIGHT and an
          // aspect ratio, so its width is whatever that computes to and it is
          // the one element on the page that does not know how wide the
          // viewport is — 300.08px identical at 320 and at 1920. Raise the
          // browser's base font to 24px and it lays out at 450px inside a
          // 360px screen, clipped by PublicShell's overflow-hidden and reading
          // "loundStac". Measured 2026-08-25.
          "block aspect-[3626/435] max-w-full leading-none [&>svg]:h-full [&>svg]:w-full",
          className,
        )}
        dangerouslySetInnerHTML={{ __html: wordmarkSvg }}
        {...rest}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn("inline-block leading-none", className)}
      dangerouslySetInnerHTML={{ __html: SOURCES[variant] }}
      {...rest}
    />
  );
}
