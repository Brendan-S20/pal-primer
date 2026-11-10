// The colour half of gaps-r2-11 part 2, pinned without a browser.
//
// `tests/viewports/axe-finds-nothing-serious-on-the-main-pages.spec.ts` is the
// real check: axe over the signed-in pages in Chromium, where contrast is
// computed from what was laid out. It needs a dev server and minutes. This
// file pins the three decisions that made those pages pass, from the source,
// in milliseconds, so an edit to a token is measured rather than trusted:
//
//   * --muted-foreground cleared 4.5:1 on white and on nothing else the app
//     puts it on (bg-muted, the setup banner's primary/5, the amber banner,
//     a destructive/10 alert). axe found it on every signed-in page.
//   * --destructive text on a destructive/5 or /10 tint was 4.36 and 3.99.
//   * A technician's colour is also their map pin, so a chip cannot darken
//     its fill to suit white initials; the initials pick white or slate-950.
//     And the avatar fallback palette was at the 600 step, five of eight
//     under 4.5:1 with white initials.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contrastOfTextOn, textClassOn } from "@/lib/text-on-a-fill";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

type Oklch = [number, number, number];
type Rgb = number[];

function oklchToSrgb([L, C, h]: Oklch): Rgb {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
    .map((v) => Math.min(1, Math.max(0, v)))
    .map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}
const luminance = (c: Rgb) => {
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (x: Rgb, y: Rgb) => {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};
/** `fg` at `alpha` over `bg`, the way a browser composites `bg-x/10`. */
const over = (fg: Rgb, bg: Rgb, alpha: number) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

/** The light-mode tokens, read from the `:root` block of src/styles.css. */
function lightTokens(): Record<string, Oklch> {
  const css = read("src/styles.css");
  const start = css.indexOf(":root {\n  --radius");
  expect(start, "the :root token block moved").toBeGreaterThan(0);
  const body = css.slice(start, css.indexOf("\n}", start));
  const out: Record<string, Oklch> = {};
  for (const m of body.matchAll(/--([a-z-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g))
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

const AMBER_500: Oklch = [0.769, 0.188, 70.08];

describe("secondary text clears 4.5:1 on every surface the app puts it on", () => {
  const t = lightTokens();
  const white = oklchToSrgb(t.background);
  const fg = oklchToSrgb(t["muted-foreground"]);
  const surfaces: Record<string, Rgb> = {
    background: white,
    "bg-muted": oklchToSrgb(t.muted),
    "bg-primary/5 (setup banner)": over(oklchToSrgb(t.primary), white, 0.05),
    "bg-amber-500/10 (banners)": over(oklchToSrgb(AMBER_500), white, 0.1),
    "bg-destructive/10 (alerts)": over(oklchToSrgb(t.destructive), white, 0.1),
  };
  for (const [name, bg] of Object.entries(surfaces)) {
    it(`muted-foreground on ${name}`, () => {
      expect(Number(ratio(fg, bg).toFixed(2))).toBeGreaterThanOrEqual(4.5);
    });
  }
});

describe("red text on a red tint clears 4.5:1 up to /10", () => {
  const t = lightTokens();
  const white = oklchToSrgb(t.background);
  const red = oklchToSrgb(t.destructive);
  for (const alpha of [0, 0.05, 0.1]) {
    it(`text-destructive on bg-destructive/${alpha * 100}`, () => {
      expect(Number(ratio(red, over(red, white, alpha)).toFixed(2))).toBeGreaterThanOrEqual(4.5);
    });
  }
  it("and the status chips that put it on a tint use /10, not /15", () => {
    for (const f of [
      "src/components/client-detail/primitives.tsx",
      "src/components/quotes/QuoteStatusBadge.tsx",
      "src/components/schedule/MobileDayList.tsx",
      "src/components/InvoiceRow.tsx",
    ]) {
      expect(read(f), f).not.toMatch(/bg-destructive\/15/);
    }
  });
});

describe("initials on a technician's map colour", () => {
  // Every colour the map palette can hand a chip, read from the file that
  // owns it rather than copied here, so a new colour is measured too.
  const palette = [
    ...new Set(
      (
        read("src/components/RouteMap.tsx").match(/const TECH_COLORS = \[([\s\S]*?)\]/)?.[1] ?? ""
      ).match(/#[0-9a-fA-F]{6}\b/g) ?? [],
    ),
  ];

  it("reads the palette (a scan of nothing would pass)", () => {
    expect(palette.length).toBeGreaterThan(5);
  });

  for (const c of palette) {
    it(`${c} gets ${textClassOn(c)} at 4.5:1 or better`, () => {
      expect(Number(contrastOfTextOn(c).toFixed(2))).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps white where white already read, and on anything that is not a hex", () => {
    expect(textClassOn("#2563eb")).toBe("text-white");
    expect(textClassOn("#d97706")).toBe("text-slate-950");
    expect(textClassOn("hsl(10 50% 50%)")).toBe("text-white");
  });

  it("is what the chip uses, with the fill left alone", () => {
    const chip = read("src/components/schedule/TechAvatar.tsx");
    expect(chip).toMatch(/color \? textClassOn\(color\)/);
    expect(chip).toMatch(/style=\{color \? \{ background: color \} : undefined\}/);
  });
});

describe("the avatar fallback palette is dark enough for white initials", () => {
  it("uses the 700 step for every tone", () => {
    const src = read("src/components/UserAvatar.tsx");
    const tones = src.match(/const TONES = \[([\s\S]*?)\]/)?.[1] ?? "";
    const steps = [...tones.matchAll(/"bg-[a-z]+-(\d+)"/g)].map((m) => m[1]);
    expect(steps.length).toBe(8);
    expect(steps.filter((s) => s !== "700")).toEqual([]);
  });
});
