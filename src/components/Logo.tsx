import markSvg from "@/assets/houndstack-mark.svg?raw";
import wordmarkSvg from "@/assets/houndstack-wordmark.svg?raw";
import logoSvg from "@/assets/houndstack-logo.svg?raw";
import { cn } from "@/lib/utils";

type Variant = "mark" | "wordmark" | "logo";

const SOURCES: Record<Variant, string> = {
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
 */
export function Logo({ variant = "mark", className, ...rest }: LogoProps) {
  return (
    <span
      aria-hidden
      className={cn("inline-block leading-none", className)}
      dangerouslySetInnerHTML={{ __html: SOURCES[variant] }}
      {...rest}
    />
  );
}
