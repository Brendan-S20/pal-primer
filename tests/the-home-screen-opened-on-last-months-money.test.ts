// The dashboard is the first screen after sign-in, and on a phone it opened
// on last month's money.
//
// The July mobile audit (docs/mobile-ux-audit.md §1.3) put it plainly: the
// page was desktop-first. Four KPI money tiles, then a 380px map, then Techs
// today, then overdue invoices, and finally two AI panels sitting open. The
// grids were responsive — `sm:grid-cols-2 lg:grid-cols-4` — but responsive
// only decided how the boxes reflowed, not which one you saw first. Reflowing
// four money tiles into one column on a 360px phone does not make them the
// right thing to lead with; it makes them four screenfuls of the wrong thing.
// The alert chips, the per-tech progress and the map — the entire answer to
// "what is happening today", which is the only reason anyone opens this page
// from a driveway — were below the fold, and the two open AI panels padded
// the scroll on the way down.
//
// ── WHAT THE FIX HAD TO NOT DO ────────────────────────────────────────────
//
// The plan's own constraint was "CSS order/conditional only, no data
// changes", and the harder half of it: desktop at `md` and up has to be
// pixel-identical. That rules out the two obvious approaches. Reordering the
// JSX would have moved the desktop grid. Branching on a JS width hook would
// have rendered two different trees, which is how a "mobile version" starts
// fetching different things from the "desktop version" and the two quietly
// stop agreeing about the numbers.
//
// So the DOM stays in desktop order and the phone gets `max-md:order-N`. Not
// `order-N md:order-none`: that emits a rule at every width and then a second
// rule to take it back, and leaves a stray order on the desktop grid the
// moment anything else lands in the same cascade layer. `max-md:` only ever
// exists inside `@media (width < 48rem)`, which makes "desktop is untouched"
// a property of the stylesheet instead of a thing someone has to remember.
//
// The blocks that lead on a phone — the header, the onboarding card, the
// alert strip — carry no order class at all. `order` defaults to 0 and every
// numbered sibling is positive, so they sort ahead for free. That is load
// bearing and invisible: giving the alert strip a helpful-looking
// `max-md:order-1` would drop it *below* the header it belongs under.
//
// ── AND THE TWO BUTTONS NOBODY COULD HIT ──────────────────────────────────
//
// The same finding ends on the header quick actions: two `size="sm"` outline
// buttons. `sm` is `h-8`, a 32px target against the 44px floor in CLAUDE.md,
// and on a phone those two are the only navigation in the header of the first
// screen an owner sees. The alert chips were the same story for a different
// reason — `py-1.5` around a 20px line box is also 32px, and they were not
// called out in July because in July they were not near the top of anything.
// The reorder is what made them the most-tapped control on the page.
//
// Both are fixed with `touch:min-h-11` rather than a new size variant: used
// height is max(min-height, height), so the min-height wins over the
// variant's `h-8` below `md` and does not exist above it.
//
// This file pins all three: the phone order, the touch targets, and — the
// part that is easiest to break by accident — that every one of those
// utilities is scoped to `max-md:` so the laptop view is the one it was.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");

/** Lazy. A read resolved in a `describe` body throws at import time when the
 *  source is stashed, and vitest reports "no tests" rather than failures —
 *  which is indistinguishable from a pass during a mutation check. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Both comment forms. The reorder and the touch fix are explained in
 *  comments that quote the markup they replaced — `md:order-none`, `h-8`,
 *  `py-1.5` — so a `not.toMatch` against raw source would fail on account of
 *  the explanation rather than the code. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const DASHBOARD = "src/routes/_authenticated/dashboard.tsx";

/** The `max-md:order-N` on the container whose class list matches `marker`.
 *
 *  Matched on the container's own distinguishing utilities (`lg:col-span-2`,
 *  `sm:grid-cols-2 lg:grid-cols-4`) rather than on the whole class string, so
 *  this keeps working when an unrelated utility is added and stops working
 *  when the block it names is gone — which is the failure worth having. */
function orderOf(src: string, marker: RegExp): number | null {
  const cls = src.match(new RegExp(`className="[^"]*${marker.source}[^"]*"`));
  if (!cls) return null;
  const n = cls[0].match(/max-md:order-(\d+)/);
  return n ? Number(n[1]) : null;
}

/** Every class token in the file, from both `className="…"` and the template
 *  literals the alert chips are built from. */
function classTokens(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
    out.push(...(m[1] ?? m[2] ?? "").split(/\s+/).filter(Boolean));
  }
  return out;
}

describe("a phone opens the dashboard on today, not on the money", () => {
  it("leads with today's operations, then money, then the AI panels", () => {
    const src = codeOnly(read(DASHBOARD));

    const today = orderOf(src, /lg:grid-cols-3/);
    const money = orderOf(src, /sm:grid-cols-2 lg:grid-cols-4/);
    const ai = orderOf(src, /flex flex-col gap-6 max-md:order-/);

    // Named individually: "the order is wrong" sends the reader hunting for
    // which of the three moved.
    expect({ today, money, ai }).toEqual({ today: 1, money: 2, ai: 3 });
  });

  it("puts per-tech progress above the map inside the today block", () => {
    // The map is 380px tall and answers a coarser question than the progress
    // bars do. On a phone it would otherwise be the whole first screenful of
    // the block that is meant to be the useful one.
    const src = codeOnly(read(DASHBOARD));
    const map = orderOf(src, /lg:col-span-2/);
    const techs = orderOf(src, /space-y-4 max-md:order-/);
    expect(techs).not.toBeNull();
    expect(map).not.toBeNull();
    expect(techs! < map!).toBe(true);
  });

  it("leaves the alert strip unordered so it stays under the header", () => {
    // `order` defaults to 0 and the three blocks above are all positive, so
    // the strip sorts first without a class. An explicit order here — even
    // `max-md:order-1`, which reads like it means "first" — would put the
    // alerts below the techs and the map.
    const src = codeOnly(read(DASHBOARD));
    const strip = src.match(/className="flex flex-wrap gap-2"/);
    expect(strip).not.toBeNull();
  });

  it("does the reorder in CSS and not by rendering two different pages", () => {
    // A width branch in JS is how a phone layout starts mounting different
    // components from the desktop one, and from there different queries. The
    // constraint in the plan was "CSS order/conditional only, no data
    // changes"; one tree at every width is what makes that checkable.
    const src = codeOnly(read(DASHBOARD));
    expect(src).not.toMatch(/useIsMobile|matchMedia|innerWidth/);
  });

  it("still asks the server for exactly what it asked for before", () => {
    // Not a test of the queries themselves — a tripwire. If a future pass at
    // this page makes the phone fetch a different summary, the two layouts
    // stop being one page and the numbers stop being comparable.
    const src = codeOnly(read(DASHBOARD));
    for (const key of ["my-org", "dashboard-summary", "billing-status"]) {
      expect(src).toMatch(new RegExp(`queryKey: \\["${key}"\\]`));
    }
    expect(src).toMatch(/refetchInterval: 60_000/);
  });

  it("keeps the AI panels collapsed so they cost one row each", () => {
    // The audit counted the two open panels as padding on the scroll. They
    // are collapsed-by-default now, and the dashboard's scroll length depends
    // on that staying true even though it lives in another file.
    const src = codeOnly(read("src/components/ai/AiPanels.tsx"));
    const section = src.slice(src.indexOf("export function AiSection"));
    expect(section.slice(0, section.indexOf("return"))).toMatch(/useState\(false\)/);
  });
});

describe("the same page on a laptop is the page it was", () => {
  it("scopes every order utility to below md", () => {
    // The hard requirement. A bare `order-2`, or an `md:order-none` paired
    // with one, changes the desktop grid — which is the one regression this
    // work was not allowed to have.
    const ordered = classTokens(codeOnly(read(DASHBOARD))).filter((t) => /(?:^|:)order-/.test(t));
    // Five: the money grid, the today grid, and inside it the map and the
    // techs column, plus the AI block. Asserted before the scoping so that a
    // page which lost its ordering altogether fails here rather than passing
    // this rule vacuously.
    expect(ordered.length).toBe(5);
    // Named, not counted.
    expect(ordered.filter((t) => !t.startsWith("max-md:"))).toEqual([]);
  });

  it("scopes the touch sizing to below md too", () => {
    // `min-h-11` on the desktop header would make two 44px buttons next to a
    // 36px heading, which is the fix showing up where it was not needed.
    const sized = classTokens(codeOnly(read(DASHBOARD))).filter((t) => /(?:^|:)min-h-11/.test(t));
    // Four: the two header buttons, the alert chip, and the phone-only Show
    // map toggle. That last one is `md:hidden` and so could never render at a
    // desktop width whatever its height class said — it is scoped anyway,
    // because a rule that has to be argued with per element is not a rule, and
    // the argument is invisible from here. Same reason as above for asserting
    // the count first: a page with no touch sizing left must not satisfy "the
    // touch sizing is correctly scoped".
    expect(sized.length).toBe(4);
    expect(sized.filter((t) => !t.startsWith("touch:"))).toEqual([]);
  });

  it("keeps the desktop grid shapes it had", () => {
    const src = codeOnly(read(DASHBOARD));
    // The four KPI columns, the 2:1 map/side split and the 380px map are the
    // desktop layout. If the reorder had been done by editing the JSX these
    // are the first things that would have drifted.
    expect(src).toMatch(/sm:grid-cols-2 lg:grid-cols-4/);
    expect(src).toMatch(/lg:grid-cols-3/);
    expect(src).toMatch(/lg:col-span-2/);
    expect(src).toMatch(/height=\{380\}/);
    expect(src).toMatch(/h-\[380px\]/);
  });

  it("keeps the header buttons at their desktop size", () => {
    // The touch fix is a min-height, not a bigger button. `size="sm"` staying
    // put is what makes the ≥md rendering identical.
    const src = codeOnly(read(DASHBOARD));
    expect(src.match(/size="sm"/g)?.length).toBe(2);
  });
});

describe("the controls on the first phone screen can be hit", () => {
  it("gives both header quick actions a 44px target on touch", () => {
    // 2.75rem. `size="sm"` is `h-8` — 32px.
    const src = codeOnly(read(DASHBOARD));
    const header = src.slice(src.indexOf('<div className="flex gap-2">'));
    const buttons = header.slice(0, header.indexOf("</div>"));
    expect(buttons.match(/touch:min-h-11/g)?.length).toBe(2);
  });

  it("gives the alert chips one as well", () => {
    // These are links to /routes, /invoices and /concerns — after the reorder,
    // the first thing under the header and the most-tapped row on the page.
    const src = codeOnly(read(DASHBOARD));
    const chip = src.match(/inline-flex items-center gap-2 rounded-md border[^`"]*/);
    expect(chip).not.toBeNull();
    expect(chip![0]).toMatch(/touch:min-h-11/);
  });

  it("centres the chip contents so the taller box does not look padded", () => {
    // `min-h` on a chip whose icon and label are top-aligned reads as a bug
    // rather than as a target. `items-center` is what keeps it invisible.
    const src = codeOnly(read(DASHBOARD));
    const chip = src.match(/inline-flex items-center gap-2 rounded-md border[^`"]*/);
    expect(chip![0]).toMatch(/items-center/);
  });

  it("has nothing on this page that only appears on hover", () => {
    // Hover does not exist on touch, and this is now the phone's home screen.
    const src = codeOnly(read(DASHBOARD));
    expect(src).not.toMatch(/group-hover:/);
  });
});
