// PR #510 review (#494). Stripe's Connect panels are iframes our CSS cannot
// reach, and connectAppearance() on /payments only ever set sizes, so in dark
// mode they rendered as white boxes on a dark page.
//
// The appearance is now two independent facts, combined: dark mode brings the
// app's dark palette, a coarse pointer brings the bigger sizes, and light mode
// with a mouse is Stripe's defaults, exactly as before. The decision is a pure
// function (src/lib/connect-appearance.ts), so it is tested here directly; the
// wiring that re-applies it when the theme changes is pinned as text below.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  COARSE_POINTER_VARIABLES,
  DARK_VARIABLES,
  connectAppearanceFor,
} from "@/lib/connect-appearance";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Any variable Stripe treats as a colour: `color*`, `*Color*`, and the
 *  backdrop. Sizes, paddings and font sizes never match. */
const isColour = (k: string) => /color/i.test(k);
const colourKeys = (v: object) => Object.keys(v).filter(isColour);

describe("Stripe Connect appearance follows the app theme", () => {
  it("dark sets the background, text and the rest of the palette", () => {
    const v = connectAppearanceFor({ dark: true, coarse: false }).variables!;
    expect(v.colorBackground).toBe("#0f172a");
    expect(v.colorText).toBe("#f8fafc");
    expect(v.colorSecondaryText).toBeTruthy();
    expect(v.colorBorder).toBeTruthy();
    expect(v.colorPrimary).toBeTruthy();
    expect(v.buttonPrimaryColorBackground).toBeTruthy();
    expect(v.badgeNeutralColorBackground).toBeTruthy();
    expect(v.formBackgroundColor).toBeTruthy();
    // A mouse in dark mode gets colours only.
    for (const k of Object.keys(COARSE_POINTER_VARIABLES)) expect(v).not.toHaveProperty(k);
  });

  it("every dark colour is a string Stripe accepts (hex or rgb, never oklch)", () => {
    for (const [k, value] of Object.entries(DARK_VARIABLES)) {
      expect(value, `${k} is ${value}`).toMatch(/^(#[0-9a-f]{6}|rgba?\([^)]*\))$/i);
    }
  });

  it("light with a mouse sets nothing: Stripe's defaults, today's look", () => {
    const v = connectAppearanceFor({ dark: false, coarse: false }).variables!;
    expect(v).toEqual({});
  });

  it("light on a finger gets the sizes and no colours", () => {
    const v = connectAppearanceFor({ dark: false, coarse: true }).variables!;
    expect(v).toMatchObject(COARSE_POINTER_VARIABLES);
    expect(v.fontSizeBase).toBe("16px");
    expect(v.tableRowPaddingY).toBe("14px");
    expect(colourKeys(v)).toEqual([]);
  });

  it("dark on a finger gets both", () => {
    const v = connectAppearanceFor({ dark: true, coarse: true }).variables!;
    expect(v).toMatchObject(COARSE_POINTER_VARIABLES);
    expect(v).toMatchObject(DARK_VARIABLES);
    expect(v.colorBackground).toBe("#0f172a");
    expect(v.buttonPaddingY).toBe("12px");
  });

  it("/payments builds its appearance from the helper and re-applies it on a theme change", () => {
    const src = read("src/routes/_authenticated/payments.tsx");
    expect(src).toMatch(/connectAppearanceFor\(\{\s*dark: isDarkApplied\(\),/);
    expect(src).toContain("appearance: connectAppearance(),");
    // The watcher is returned from the effect, so unmount disconnects it.
    expect(src).toMatch(
      /return watchDarkTheme\(\(\) => \{\s*instance\.update\(\{ appearance: connectAppearance\(\) \}\);/,
    );
  });
});
