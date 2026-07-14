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
          "block aspect-[3626/435] leading-none [&>svg]:h-full [&>svg]:w-full",
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
