// A responsive sweep of the whole app, and the thing it kept finding.
//
// The brief was "everything has to be responsive" and "everything should fit
// in its designated field — some are off-centred or don't fit". Measured
// rather than eyeballed, almost all of it came down to one rule from
// CLAUDE.md and one component that had been copied instead of shared.
//
// ── TABLES DECIDING THE WIDTH OF THE PAGE ─────────────────────────────────
//
// `ui/table.tsx` wraps its `<table>` in `overflow-auto`, so anything built
// with `<Table>` was already right. Twenty-eight tables in the app are raw
// `<table>` elements with four or more columns, and thirteen of those had
// been given a scroll container by hand. Fifteen had not, and they failed in
// two different ways:
//
//   TEN had no container at all. A four-to-seven column table inside a card
//   sets the width of the widest thing on the page, and the page is what
//   scrolls. That is the first rule in CLAUDE.md and the most visible way an
//   app feels broken on a phone.
//
//   FIVE were worse: they sat inside `overflow-hidden`. That is not a scroll
//   container, it is a guillotine. On /analytics, /imports and the three AI
//   panels — one of which is nine columns wide — the right-hand columns were
//   simply cut off. No scrollbar, no indication, no way to reach them. The
//   nine-column one ends in "Confidence" and "Why", which is the half of a
//   pricing suggestion that tells you whether to trust it.
//
// The fix is the same in all fifteen and it is the pattern the other thirteen
// already used. This file asserts the rule over the whole repository rather
// than over the fifteen, so the next raw table has to comply too.
//
// ── A TAB BAR THAT HAD BEEN FIXED ONCE, IN ONE PLACE ──────────────────────
//
// /clients/$id carries nine tabs and someone had already taught THAT ONE to
// scroll sideways on a phone. The classes to do it were sitting in the route
// file. /analytics has seven tabs and platform tenants has seven, and both
// still wrapped into rows of pills.
//
// So the phone behaviour moved onto `TabsList` itself, where a shared
// component's behaviour belongs, and the route keeps only its desktop-specific
// choice to wrap. Nobody has to remember it again.
//
// The triggers were 28px tall — `py-1` around a 20px line box — against a 44px
// rule. That is a target you aim at rather than one you hit, and it is the
// primary navigation of the busiest screen in the product.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/** Lazy. A read resolved in a `describe` body throws at import time when the
 *  source is stashed, and vitest reports "no tests" rather than failures —
 *  which is indistinguishable from a pass during a mutation check. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Both comment forms. The fixes below are explained in comments that quote
 *  the markup they replaced — `overflow-hidden`, `flex-wrap`, `py-1` — so a
 *  `not.toMatch` against raw source would fail on the account of the fix. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** How far above a `<table>` to look for its scroll container.
 *
 *  Not arbitrary: a container that is `<CardContent className="overflow-x-auto">`
 *  can sit twenty-odd lines above the table with a loading branch and an
 *  empty-state branch in between. Measured across the repo — 10 lines misses
 *  two real containers, 15 misses one, 25 misses none. */
const LOOKBACK = 25;

type WideTable = { file: string; line: number; cols: number; before: string };

const wideTables = (): WideTable[] => {
  const found: WideTable[] = [];
  for (const file of tsxFiles(join(root, "src"))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/<table[\s>]/.test(line)) return;
      const seg = lines.slice(i, i + 60).join("\n");
      const end = seg.indexOf("</table>");
      const head = end === -1 ? seg : seg.slice(0, end);
      const cols = (head.match(/<th[\s>]/g) || []).length;
      // Two- and three-column label/value tables cannot overflow a phone and
      // are deliberately exempt; requiring a scroller on them would be noise.
      if (cols < 4) return;
      found.push({
        file: file.slice(root.length + 1),
        line: i + 1,
        cols,
        before: lines.slice(Math.max(0, i - LOOKBACK), i).join("\n"),
      });
    });
  }
  return found;
};

describe("a wide table scrolls inside its own box, never the page", () => {
  it("finds the wide tables, so a green run means checked and not skipped", () => {
    // If this collapses to zero the rules below are vacuously true and would
    // stay green through any number of new full-width tables.
    expect(wideTables().length).toBeGreaterThan(20);
  });

  it("gives every one of them a horizontal scroll container", () => {
    const stranded = wideTables()
      .filter((t) => !/overflow-x-auto|overflow-auto/.test(t.before))
      .map((t) => `${t.file}:${t.line} (${t.cols} columns)`);
    // Named, not counted — "10 violations" sends the reader hunting.
    expect(stranded).toEqual([]);
  });

  it("never lets one be clipped by overflow-hidden instead", () => {
    // The failure that hides data rather than merely making it awkward. A
    // wrapper whose nearest overflow rule is `hidden` cuts the right-hand
    // columns off with no scrollbar and no way to reach them.
    const guillotined = wideTables()
      .filter((t) => {
        const hidden = t.before.lastIndexOf("overflow-hidden");
        if (hidden === -1) return false;
        const scrolls = Math.max(
          t.before.lastIndexOf("overflow-x-auto"),
          t.before.lastIndexOf("overflow-auto"),
        );
        return hidden > scrolls;
      })
      .map((t) => `${t.file}:${t.line} (${t.cols} columns)`);
    expect(guillotined).toEqual([]);
  });

  it("keeps the shared Table component scrolling, which is why it was exempt", () => {
    // Everything built on `<Table>` was always fine. If this regresses, the
    // rule above silently stops covering most of the app's tables.
    expect(codeOnly(read("src/components/ui/table.tsx"))).toMatch(
      /<div className="relative w-full overflow-auto">/,
    );
  });
});

describe("a tab bar scrolls on a phone instead of wrapping into pills", () => {
  const tabs = () => codeOnly(read("src/components/ui/tabs.tsx"));

  it("puts the phone behaviour on the shared component", () => {
    const src = tabs();
    expect(src).toMatch(/max-md:overflow-x-auto/);
    expect(src).toMatch(/max-md:w-full/);
    expect(src).toMatch(/max-md:justify-start/);
    // Without this the scroller shows a scrollbar across the tab bar on every
    // platform that draws one.
    expect(src).toMatch(/no-scrollbar/);
  });

  it("gives the triggers a 44px target on touch and stops them squeezing", () => {
    const src = tabs();
    // 2.75rem. `py-1` around a 20px line box is 28px.
    expect(src).toMatch(/touch:min-h-11/);
    expect(src).toMatch(/max-md:shrink-0/);
  });

  it("leaves the desktop sizing alone", () => {
    // The whole change is behind `max-md:`. A tab bar that grew on a laptop
    // would be a regression dressed as a fix.
    expect(tabs()).toMatch(/inline-flex h-9 items-center justify-center rounded-lg/);
  });

  it("stops the client page carrying its own private copy", () => {
    // It had the identical four classes inline. Two copies of one behaviour
    // is how /analytics and the tenants page were left behind in the first
    // place.
    const src = codeOnly(read("src/routes/_authenticated/clients.$clientId.tsx"));
    const list = src.slice(src.indexOf("<TabsList"), src.indexOf("<TabsTrigger"));
    expect(list).not.toMatch(/max-md:overflow-x-auto/);
    expect(list).not.toMatch(/no-scrollbar/);
    // Nine tabs still wrap above md — that part is genuinely local.
    expect(list).toMatch(/flex-wrap/);
  });

  it("scopes the tenants page's wrapping to desktop", () => {
    // `flex-wrap` and `overflow-x` together mean the bar neither wraps
    // usefully nor scrolls.
    const src = codeOnly(read("src/routes/platform.tenants.$id.tsx"));
    const list = src.slice(src.indexOf("<TabsList"), src.indexOf("<TabsTrigger"));
    expect(list).toMatch(/md:flex-wrap/);
    expect(list).not.toMatch(/(?<!md:)\bflex-wrap/);
  });
});

describe("the last three controls under the 44px floor", () => {
  // `ui/button.tsx` and `ui/tabs.tsx` were done first because they are the
  // loud ones. These three are quieter and they are most of the product: a
  // form on a phone is inputs and selects, and the bulk-action columns on
  // every table are checkboxes.
  //
  // `min-h`, not `h`, throughout. `min-height` beats `height` in CSS's
  // used-value calculation no matter which order the utilities land in, so a
  // caller passing its own `h-8` still gets a 44px target. With `touch:h-11`
  // the result depends on class order, which is not a thing to leave to the
  // order somebody happened to type.

  it("gives a text input a 44px target on touch and leaves the laptop alone", () => {
    const src = codeOnly(read("src/components/ui/input.tsx"));
    expect(src).toMatch(/touch:min-h-11/);
    // 36px above the breakpoint, exactly as before.
    expect(src).toMatch(/flex h-9 w-full rounded-md/);
  });

  it("gives a select trigger AND its options the same floor", () => {
    // The trigger alone is half the control. `py-1.5` around a 20px line box
    // is a 32px option row, and picking the wrong service day off a dropdown
    // in a driveway is the failure this floor exists to prevent.
    const src = codeOnly(read("src/components/ui/select.tsx"));
    const trigger = src.slice(src.indexOf("SelectTrigger"), src.indexOf("SelectScrollUpButton"));
    expect(trigger).toMatch(/touch:min-h-11/);
    const item = src.slice(src.indexOf("const SelectItem"), src.indexOf("SelectItem.displayName"));
    expect(item).toMatch(/touch:min-h-11/);
  });

  it("expands the checkbox's hit area without expanding the checkbox", () => {
    // The one control that cannot take the same fix. A 44px square is a
    // different component, not a bigger version of this one, so the 44px box
    // is an out-of-flow pseudo-element and the 16px square is untouched.
    const src = codeOnly(read("src/components/ui/checkbox.tsx"));
    expect(src).toMatch(/touch:before:h-11/);
    expect(src).toMatch(/touch:before:w-11/);
    // Absolute + centred, or it is a 44px block shoving the row open.
    expect(src).toMatch(/touch:before:absolute/);
    expect(src).toMatch(/touch:before:-translate-x-1\/2/);
    expect(src).toMatch(/touch:before:-translate-y-1\/2/);
    // Tailwind emits no pseudo-element at all without `content`, so this one
    // missing class would make the whole thing a silent no-op that still
    // matches every assertion above.
    expect(src).toMatch(/touch:before:content-\[''\]/);
    // The pseudo positions against the box, so the box has to establish one.
    expect(src).toMatch(/\brelative\b/);
    // And the square itself is still 16px.
    expect(src).toMatch(/\bh-4 w-4 shrink-0 rounded-sm\b/);
  });

  it("keeps all four of them behind the touch variant", () => {
    // A control that got taller on a laptop-with-a-mouse would be a regression
    // dressed as a fix — the same check tabs.tsx already carries.
    //
    // The scope used to be `max-md:`. It is now `touch:` (a coarse pointer OR
    // a narrow viewport, defined in src/styles.css), which is a superset: the
    // laptop this guards is still excluded, and iPads — touch devices at
    // 744-1366px, which `max-md:` silently left out — are no longer.
    for (const f of [
      "src/components/ui/input.tsx",
      "src/components/ui/select.tsx",
      "src/components/ui/checkbox.tsx",
      "src/components/ui/button.tsx",
    ]) {
      const src = codeOnly(read(f));
      expect(src, `${f} has an unscoped min-h-11`).not.toMatch(/(?<!touch:)\bmin-h-11\b/);
    }
  });
});

describe("a table in a scroll container still has to be wider than the container", () => {
  // ── WHY A SCROLL CONTAINER IS NOT ENOUGH ────────────────────────────────
  //
  // The rule above requires every 4+ column table to sit inside an
  // `overflow-x-auto`. That stops the PAGE scrolling sideways and it does not
  // stop the table squashing: `w-full` with no minimum makes the table shrink
  // to fit the container, so the scroller never engages and the columns
  // collapse into each other instead.
  //
  // Measured on an iPhone SE (375pt) on 2026-08-23: the Billing history header
  // read "PERIODAMOUNTSTATUS" — PERIOD ended at x=170, AMOUNT began at x=169,
  // ended 225, STATUS began at 224. Two 1pt overlaps, three unreadable words.
  // The container was present the whole time, so the existing rule passed.
  //
  // A `min-w-` floor is what makes the overflow real. 4+ columns only, because
  // that is exactly the set the rule above guarantees a scroll container for —
  // adding a minimum to a table that has none would push the page sideways,
  // which is the fault this file exists to prevent.
  const files = tsxFiles(join(root, "src"));

  it("finds the tables at all", () => {
    const total = files.reduce(
      (n, f) => n + (codeOnly(readFileSync(f, "utf8")).match(/<table className="/g) ?? []).length,
      0,
    );
    expect(total).toBeGreaterThan(20);
  });

  it("gives every 4-plus-column table a min-width", () => {
    const stranded: string[] = [];
    for (const f of files) {
      const code = codeOnly(readFileSync(f, "utf8"));
      for (const m of code.matchAll(/<table className="([^"]*)"/g)) {
        const cls = m[1];
        const after = code.slice(m.index! + m[0].length, m.index! + m[0].length + 1600);
        const cols = (after.match(/<th\b/g) ?? []).length;
        if (cols < 4 || /min-w-/.test(cls)) continue;
        const line = code.slice(0, m.index).split("\n").length;
        stranded.push(`${f.replace(root + "/", "")}:${line}  ${cols} columns  ${cls.slice(0, 60)}`);
      }
    }
    expect(
      stranded,
      "these tables are `w-full` inside a scroll container with no minimum, so they " +
        "shrink to the container instead of overflowing it and their columns collide " +
        "at phone widths. Add a min-w-[Npx] floor.",
    ).toEqual([]);
  });
});

describe("two more things measured at 360px", () => {
  it("caps the Crew popover so it fits a phone", () => {
    // 320px of popover on a 320px screen, with the page's own padding still
    // to pay for.
    const src = codeOnly(read("src/routes/_authenticated/routes.tsx"));
    expect(src).toMatch(/className="w-80 max-w-\[calc\(100vw-1rem\)\] p-0"/);
  });

  it("stacks the revenue tiles two-up instead of four-across", () => {
    // Four money figures across 360px is about 80px each, and
    // "Avg monthly / client" needs more than that before the number under it.
    const src = codeOnly(read("src/routes/_authenticated/analytics.tsx"));
    expect(src).toMatch(
      /grid-cols-2 gap-4 text-sm \$\{anyRefunds \? "sm:grid-cols-4" : "sm:grid-cols-3"\}/,
    );
  });
});
