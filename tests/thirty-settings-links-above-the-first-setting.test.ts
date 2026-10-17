// QA row 36, 2026-10-15: about thirty Settings links filled 480 to 560px of
// height above any setting, at every width from an iPad in portrait to a
// 1440px laptop, because the section list was a cloud of wrapping chips in
// rows headed by a 144px label.
//
// Now one <nav> in two shapes. From 1024px (`lg`) it is a grouped vertical
// menu in a side column, sticky under the header and scrolling on its own.
// From 768 to 1023 it is a single row that scrolls sideways inside its own
// container. Below 768 the picker button and sheet are unchanged.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const src = readFileSync(join(root, "src/routes/_authenticated/settings.tsx"), "utf8");
const layout = src.slice(src.indexOf("function SettingsLayout"));

/** The class list of the element carrying `aria-label="Settings sections"`. */
function navClass(): string {
  const at = layout.indexOf('aria-label="Settings sections"');
  expect(at, "the Settings sections nav").toBeGreaterThan(0);
  const m = layout.slice(at).match(/:\s*"([^"]+)"/);
  expect(m, "the nav's non-empty class list").not.toBeNull();
  return m![1];
}

describe("the Settings section menu", () => {
  it("is a side column from 1024px: beside the content, sticky, scrolling on its own", () => {
    expect(layout).toMatch(/lg:grid lg:grid-cols-\[13rem_minmax\(0,1fr\)\]/);
    const cls = navClass();
    expect(cls).toMatch(/\blg:sticky\b/);
    expect(cls).toMatch(/\blg:overflow-y-auto\b/);
    expect(cls).toMatch(/lg:max-h-\[calc\(100dvh-/);
    // Stacked, with the group headings drawn only here.
    expect(layout).toMatch(/lg:flex-col lg:gap-4/);
    expect(layout).toMatch(/uppercase tracking-wider text-muted-foreground max-lg:hidden/);
    // The content beside it can shrink rather than push the page wider.
    expect(layout).toMatch(/<div className="min-w-0">\s*<Outlet \/>/);
  });

  it("is one sideways-scrolling row from 768 to 1023, never a wrapping cloud", () => {
    const cls = navClass();
    expect(cls).toMatch(/\boverflow-x-auto\b/);
    expect(cls).toMatch(/\bmd:block\b/);
    expect(layout).toMatch(/className="flex w-max gap-1 lg:w-auto lg:flex-col lg:gap-4"/);
    expect(layout).toMatch(/whitespace-nowrap rounded-md px-3 py-1 text-sm/);
    // The cloud's two ingredients.
    expect(layout).not.toMatch(/flex flex-wrap items-baseline gap-1/);
    const menu = layout.slice(layout.indexOf("<nav"), layout.indexOf("</nav>"));
    expect(menu).not.toMatch(/\bw-36\b/);
  });

  it("keeps the phone picker below 768 and every section reachable", () => {
    expect(layout).toMatch(/className=\{oneSection \? "hidden" : "md:hidden"\}/);
    // Every link still comes from TAB_GROUPS through the same filter, so the
    // menu cannot offer a section the picker does not, or the other way round.
    expect(layout.match(/groups\.map\(\(group/g)?.length).toBeGreaterThanOrEqual(2);
    expect(layout).toMatch(/\(role !== "tech" \|\| t\.techVisible\) &&\s*canAccess\(role, t\.to\)/);
  });

  it("keeps the open section in view inside its own scroller", () => {
    expect(layout).toMatch(/data-active=\{active \? "true" : undefined\}/);
    expect(layout).toMatch(/aria-current=\{active \? "page" : undefined\}/);
    expect(layout).toMatch(/scrollIntoView\?\.\(\{ block: "nearest", inline: "nearest" \}\)/);
  });

  it("keeps each link a 44px target on a touch screen", () => {
    expect(layout).toMatch(/inline-flex shrink-0 items-center whitespace-nowrap[^`]*touch:min-h-11/);
  });
});
