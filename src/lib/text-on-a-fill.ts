// White or near-black text, whichever reads on a given fill.
//
// For a fill the caller cannot change. A technician's colour on the dispatch
// board is the colour of their pins and polylines on the map, so darkening
// the chip to suit white initials would leave a chip and its own pin
// disagreeing about who is who. But half of the map palette is too light for
// white text: amber is 3.18:1 and cyan 3.68:1, which axe flagged as
// color-contrast on the schedule (gaps-r2-11 part 2). So the fill stays and
// the TEXT picks whichever of the two has the higher WCAG contrast.
//
// Returns a Tailwind class, not a colour, so the caller stays a component
// that cannot name one.

function channel(hex: string, at: number): number {
  const c = parseInt(hex.slice(at, at + 2), 16) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Relative luminance of `#rrggbb`, or null for anything else. */
export function luminanceOf(fill: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(fill.trim());
  if (!m) return null;
  return 0.2126 * channel(m[1], 0) + 0.7152 * channel(m[1], 2) + 0.0722 * channel(m[1], 4);
}

/** slate-950's luminance. Slate-900 (the app's foreground) leaves teal
 *  #0d9488 at 4.47:1, just under the line. */
const SLATE_950 = 0.0015;

/** `text-white` or `text-slate-950`, whichever has more contrast on `fill`.
 *  Anything that is not a `#rrggbb` keeps white, which is what it was. */
export function textClassOn(fill: string): "text-white" | "text-slate-950" {
  const l = luminanceOf(fill);
  if (l === null) return "text-white";
  const onWhite = 1.05 / (l + 0.05);
  const onDark = (l + 0.05) / (SLATE_950 + 0.05);
  return onWhite >= onDark ? "text-white" : "text-slate-950";
}

/** WCAG contrast of that choice, for tests. */
export function contrastOfTextOn(fill: string): number {
  const l = luminanceOf(fill) ?? 0;
  return textClassOn(fill) === "text-white" ? 1.05 / (l + 0.05) : (l + 0.05) / (SLATE_950 + 0.05);
}
