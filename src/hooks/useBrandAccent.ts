import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getMyOrg } from "@/lib/org.functions";

/**
 * Resolves the signed-in org's brand color into a small palette we can apply
 * as CSS variables inside the authenticated app. Returns null when there's
 * no valid brand color, or when the color would produce poor contrast
 * regardless of which text tone we pick — in that case callers should fall
 * back to the default theme tokens.
 */

function parseHex(input: unknown): { r: number; g: number; b: number } | null {
  if (typeof input !== "string") return null;
  const m = input.trim().match(/^#?([0-9a-fA-F]{6})$/);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function relLuminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const srgb = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2];
}

function contrastRatio(lumA: number, lumB: number): number {
  const [hi, lo] = lumA > lumB ? [lumA, lumB] : [lumB, lumA];
  return (hi + 0.05) / (lo + 0.05);
}

export type BrandAccent = {
  hex: string;
  /** "#ffffff" or "#0b1220" depending on which reads better on `hex`. */
  fg: string;
  /** Translucent tint suitable for hover / active-nav backgrounds. */
  soft: string;
};

export function useBrandAccent(): BrandAccent | null {
  const fn = useServerFn(getMyOrg);
  const { data } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });
  const raw = data?.organization?.brand_color;
  const rgb = parseHex(raw);
  if (!rgb) return null;
  const hex = `#${raw!.trim().replace(/^#/, "").toLowerCase()}`;
  const lum = relLuminance(rgb);
  const white = 1;
  const dark = relLuminance({ r: 11, g: 18, b: 32 }); // ~ #0b1220
  const cWhite = contrastRatio(lum, white);
  const cDark = contrastRatio(lum, dark);
  // If neither tone clears WCAG AA for large text (3.0), skip so we don't
  // ship an unreadable primary button.
  if (Math.max(cWhite, cDark) < 3) return null;
  const fg = cWhite >= cDark ? "#ffffff" : "#0b1220";
  const soft = `color-mix(in oklab, ${hex} 18%, transparent)`;
  return { hex, fg, soft };
}
