// QA rows 20 and 35, 2026-10-15. My Day's sticky header plus the Resume and
// tab bars took about 35% of a 390px screen, and about half of it offline.
// The header was see-through (60-80% background with a blur), hard to read
// in sun glare on a phone and, on a desktop, hiding the address of the stop
// being scrolled to. And at 1440px My Day was the phone layout 1100px wide.
//
// Now: the header is opaque; the progress rule is behind the percentage,
// which is a button with an info glyph; each offline notice is one line; and
// from `lg` the list and the header's contents are held to a reading column.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

const root = join(import.meta.dirname, "..");
const src = readFileSync(join(root, "src/routes/_authenticated/my-day.tsx"), "utf8");

/** The sticky header's own element, found by the attribute the margins and
 *  room-back specs select it by. */
function stickyBarClass(): string {
  const at = src.indexOf('data-page-bleed=""');
  expect(at, "no data-page-bleed element in my-day.tsx").toBeGreaterThan(0);
  const cls = src.slice(at).match(/className=\{`([^`]+)`\}/);
  expect(cls, "the sticky bar's className").not.toBeNull();
  return cls![1];
}

describe("My Day's sticky header", () => {
  it("is opaque", () => {
    const cls = stickyBarClass();
    expect(cls).toMatch(/\bsticky\b/);
    expect(cls).toMatch(/(^|\s)bg-background(\s|$)/);
    expect(cls).not.toMatch(/bg-background\/\d+/);
    expect(cls).not.toMatch(/backdrop-blur/);
  });

  it("puts the progress rule behind a button, not in a paragraph on every visit", () => {
    const popover = src.indexOf("<PopoverContent");
    const rule = src.indexOf('t("myDay.progressRule")');
    expect(popover).toBeGreaterThan(0);
    expect(rule, "the rule is still on the page").toBeGreaterThan(popover);
    expect(src.match(/t\("myDay\.progressRule"\)/g)).toHaveLength(1);
    // The trigger has a name, and a 44px box with its label inside it.
    expect(src).toMatch(/aria-label=\{t\("myDay\.howProgressCounts"\)\}/);
    expect(src).toMatch(/className="inline-flex min-h-11 min-w-11 shrink-0[^"]*"/);
    // The missed count moved into the progress line rather than vanishing.
    expect(src).toContain('t("myDay.missedCount", { count: missedCount })');
  });

  it("names the button in all four languages", () => {
    for (const [lng, l] of Object.entries({ en, es, ar, zh })) {
      const v = (l as { myDay: Record<string, string> }).myDay.howProgressCounts;
      expect(v, lng).toBeTruthy();
    }
  });

  it("draws each offline notice as one line that truncates", () => {
    // The two notices, each a single flex row whose text is one truncating
    // span. The old cards were `p-2.5` with a second line under the first.
    const notices = src.match(/flex min-h-9 items-center gap-2 rounded-md border ps-2\.5 text-xs/g);
    expect(notices).toHaveLength(2);
    expect(src).toContain('className="min-w-0 flex-1 truncate py-1 font-medium"');
    expect(src).toContain('className="block w-full truncate py-1 text-start touch:min-h-11"');
    expect(src).not.toMatch(/rounded-lg border p-2\.5 text-sm animate-fade-in/);
    // Offline with a saved copy, the saved-copy line already says "Offline",
    // so the connection line is not drawn above it a second time.
    expect(src).toMatch(
      /\(!online \|\| pending > 0\) && !\(freshness\?\.status === "cached" && !online\)/,
    );
    // Both actions are 44px on a touch screen.
    expect(src.match(/hover:bg-current\/10 active:scale-95 transition-transform touch:min-h-11/g)).toHaveLength(2);
  });

  it("lets a touch user read the full saved-copy age and stale-route warning", () => {
    expect(src).toMatch(/aria-label=\{`\$\{headline\}\$\{queued\}\. \$\{updated\}\$\{warning\}`\}/);
    expect(src).toMatch(/<PopoverContent[^>]*>[\s\S]*?<p>\{headline\}\{queued\}<\/p>\s*<p>\{updated\}<\/p>/);
    expect(src).toMatch(/freshness\.beyondTrustHorizon && <p>\{t\("myDay\.routeMayHaveChanged"\)\}<\/p>/);
  });
});

describe("My Day on a wide screen", () => {
  it("holds the list and the header's contents to one reading column from lg", () => {
    expect(src).toMatch(/<div className="space-y-2 py-3 lg:mx-auto lg:max-w-3xl">/);
    expect(src).toMatch(/view === "map" \? "" : "lg:mx-auto lg:max-w-3xl"/);
  });

  it("leaves the page root alone, which is PageShell's to size", () => {
    // tests/a-page-does-not-draw-its-own-column.test.ts holds the root; this
    // says the cap above is on a child, by construction.
    expect(src).toMatch(/<div className=\{view === "map" \? "" : belowTabBarPadding\}>/);
  });
});
