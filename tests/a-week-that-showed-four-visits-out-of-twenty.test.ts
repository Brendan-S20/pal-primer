// "When going to the week view, it should somewhat look how Jobber is laid out,
//  utilizing the icons assigned per names. I also feel I am still not receiving
//  the fullness to the windows that Jobber provides."
//
// Three complaints with three different causes, and this file pins the fix to
// each of them so the next edit to the calendar has to keep them.
//
// ── THE FULLNESS ONE IS ARITHMETIC, NOT TASTE ─────────────────────────────
//
// A day cell was `min-h-[7rem]` and rendered `CHIPS_PER_DAY` chips before
// collapsing the rest into "+N more". On the week that meant a busy org saw
// four of twenty visits per day — 28 of 140 across the week — inside a card
// with most of its height unused, because the cell's minimum height was also
// very nearly its maximum. Both halves of "empty and yet truncated" came from
// the same decision, which is correct for a month cell (thirty of them have to
// fit) and wrong for a week column (there are seven and they have the page).
//
// The week's columns are now a fixed height and scroll INSIDE themselves. That
// is what makes them dense and what stops the page growing, and it is the only
// reason the chip cap can be lifted at all — so the two are asserted together
// below. A column with `overflow-y-auto` and no height is not a scroller, and
// a flex child with no `min-h-0` cannot be one either: its minimum is its
// content, so it grows to fit twenty chips and takes the page with it.
//
// ── THE WIDTH ONE IS ALSO ARITHMETIC ──────────────────────────────────────
//
// The map split is `lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]`. On a 1024px
// laptop the calendar's share is about 570px, and seven columns of that are
// 74px each — a client name of three characters and a badge. The answer a
// browser gives you for free is to let the page get wider, and that is the one
// thing CLAUDE.md rules out outright. So the grid keeps a floor on its own
// width and its CONTAINER scrolls, which is the same trade `ui/table.tsx`
// makes, and the floor is `md:`-only because below that there is one column
// and nothing to floor.
//
// ── AND THE ICONS ONE IS ABOUT NOT HAVING TWO PALETTES ────────────────────
//
// The badge is only worth anything if a technician is the same colour here as
// on the map beside it. `techColorMap` delegates to `buildTechGroups` so that
// the calendar and the pins cannot disagree — including in the case that makes
// a second implementation drift, where the colour index advances only for
// techs who actually have visits in the window. The guard that keeps it that
// way is not "the calendar calls techColorMap" — it does not, it takes the map
// as a prop — but that no file in the schedule folder knows a colour at all.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { techInitials } from "@/components/schedule/TechAvatar";

const root = join(import.meta.dirname, "..");

/** Lazy. A read resolved in a `describe` body throws at import time when the
 *  source is stashed, and vitest reports "no tests" rather than failures —
 *  which is indistinguishable from a pass during a mutation check. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Both comment forms. The component's header comment quotes the markup it
 *  replaced — `min-h-[7rem]`, "+3 more", the 8px dot — so a `not.toMatch`
 *  against raw source would fail on the account of the fix rather than on the
 *  defect. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const calendar = () => codeOnly(read("src/components/schedule/ScheduleCalendar.tsx"));

describe("a technician is the same colour here as on the map", () => {
  it("keeps one palette in the app, in the file that draws the pins", () => {
    // The failure this prevents is not a crash, it is two panes over the same
    // visits quietly disagreeing about who is who — which is worse than having
    // no colour at all, because it still looks like an answer.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (e.name.endsWith(".tsx") || e.name.endsWith(".ts")) {
          if (/TECH_COLORS/.test(readFileSync(join(root, dir, e.name), "utf8"))) {
            files.push(`${dir}/${e.name}`);
          }
        }
      }
    };
    walk("src");
    expect(files).toEqual(["src/components/RouteMap.tsx"]);
  });

  it("scans for hexes with something that can actually find one", () => {
    // The assertion below is of the form "nothing is wrong", which passes on a
    // scanner that reads nothing at all. This is the same regex over the file
    // that DOES hold the palette, so a green run there means checked rather
    // than skipped.
    const palette = codeOnly(read("src/components/RouteMap.tsx")).match(/#[0-9a-fA-F]{3,8}\b/g);
    expect(palette?.length ?? 0).toBeGreaterThan(5);
  });

  it("leaves the schedule components unable to name a colour", () => {
    // A hex literal in here is the first half of a second palette. Colour
    // arrives as the `techColors` prop and reaches the badge as `color`; there
    // is nothing else for a hex to be doing.
    const offenders: string[] = [];
    for (const e of readdirSync(join(root, "src/components/schedule"))) {
      const src = codeOnly(read(`src/components/schedule/${e}`));
      for (const m of src.match(/#[0-9a-fA-F]{3,8}\b/g) ?? []) {
        offenders.push(`src/components/schedule/${e}: ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("puts the badge on the chip and takes its colour from the prop", () => {
    const src = calendar();
    expect(src).toMatch(/<TechAvatar name=\{who\} color=\{color\} \/>/);
    expect(src).toMatch(
      /color=\{\s*v\.assigned_staff_id \? techColors\.get\(v\.assigned_staff_id\)/,
    );
  });

  it("falls back to an outline rather than a grey fill when nobody is on it", () => {
    // Grey is a colour. On a board where colour means "whose route", a grey
    // badge reads as one more technician — which is the same argument the
    // hollow dot was already making before the badge replaced it.
    const src = codeOnly(read("src/components/schedule/TechAvatar.tsx"));
    expect(src).toMatch(/style=\{color \? \{ background: color \} : undefined\}/);
    expect(src).toMatch(/border-dashed/);
  });
});

describe("initials", () => {
  it("takes the first and last name", () => {
    expect(techInitials("Brendan North")).toBe("BN");
    expect(techInitials("  ada   byron   lovelace ")).toBe("AL");
  });

  it("takes two letters when there is only one word", () => {
    expect(techInitials("Sam")).toBe("SA");
    expect(techInitials("Bo")).toBe("BO");
  });

  it("gives an unassigned visit nothing to say rather than a wrong answer", () => {
    expect(techInitials(null)).toBe("");
    expect(techInitials(undefined)).toBe("");
    expect(techInitials("   ")).toBe("");
  });

  it("does not cut a name in half through a code point", () => {
    // `"🙂x".slice(0, 2)` is a lone surrogate and renders as a replacement
    // character. Iterating the string gives code points, so a single-word name
    // starting with an astral character comes back whole.
    expect(techInitials("🙂x")).toBe("🙂X");
  });
});

describe("a week column is full, and scrolls rather than growing the page", () => {
  it("gives the week's columns a height and makes them the scroller", () => {
    const src = calendar();
    // All three parts, because any one of them alone is a no-op: a height with
    // no overflow clips, an overflow with no height never triggers, and a flex
    // child without `min-h-0` refuses to be shorter than its content whatever
    // else it is told.
    expect(src).toMatch(/md:h-\[\d+rem\]/);
    expect(src).toMatch(/md:min-h-0 md:flex-1 md:overflow-y-auto/);
  });

  it("stops capping the week at four chips where the column can scroll", () => {
    const src = calendar();
    // The month still collapses in JS — its cells are hidden below `md` and a
    // chip rendered into a hidden cell costs a render for nothing. The week
    // renders all of them and cuts the PHONE's copy off in CSS, because at
    // `md` the column scrolls and there is nothing to cut off.
    expect(src).toMatch(
      /const rendered = isMonth && !isOpen \? list\.slice\(0, CHIPS_PER_DAY\) : list;/,
    );
    expect(src).toMatch(/hiddenOnPhone=\{!isMonth && i >= phoneCut\}/);
    // And the "+N more" control that does the cutting is a phone control now.
    expect(src).toMatch(/isMonth \? "hidden md:block" : "md:hidden"/);
  });

  it("scrolls the grid sideways inside its own container, never the page", () => {
    const src = calendar();
    const at = src.indexOf("const weekScroll");
    expect(at).toBeGreaterThan(0);
    const decls = src.slice(at, src.indexOf("return (", at));
    // Both halves are `md:`-only and both are off for the month: a 320px month
    // has to FIT, and giving it a floor would hand the phone a sideways scroll
    // in place of a layout.
    expect(decls).toMatch(/isMonth \? "" : "md:-mx-0\.5 md:overflow-x-auto/);
    expect(decls).toMatch(
      /isMonth \? "" : cols === 5 \? "md:min-w-\[\d+rem\]" : "md:min-w-\[\d+rem\]"/,
    );
    // And every floor in there is `md:`-prefixed. An unprefixed one applies at
    // 360px, where the grid is one column and a floor is not a floor, it is a
    // sideways scroll on a phone.
    expect(decls.match(/(?<!md:)min-w-\[\d+rem\]/g)).toBeNull();
  });
});

describe("the column header says which day and how much of it", () => {
  it("counts visits in words rather than leaving a bare number", () => {
    // "21 visits" is the header Jobber shows and the one the owner asked for.
    // The month keeps the bare number — a month cell is a two-digit number
    // over a two-digit number and that is the whole reason seven columns fit
    // at 320px.
    expect(calendar()).toMatch(
      /isMonth\s+\? list\.length\s+: `\$\{list\.length\} visit\$\{list\.length === 1 \? "" : "s"\}`/,
    );
  });

  it("highlights today's column, not merely today's cell", () => {
    const src = calendar();
    expect(src).toMatch(/const isToday = d === todayIso;/);
    expect(src).toMatch(/isToday \? "bg-primary\/10 text-primary" : ""/);
    expect(src).toMatch(/isToday \? "border-primary ring-1 ring-primary" : ""/);
  });

  it("groups the untimed work under its own heading instead of interleaving it", () => {
    const src = calendar();
    // Sorting by `sequence` alone put an 8am stop below an un-routed visit
    // whose sequence happened to be lower, and a column that is not in time
    // order cannot be read down.
    expect(src).toMatch(/if \(am !== bm\) return \(am \?\? 1e6\) - \(bm \?\? 1e6\);/);
    expect(src).toMatch(/const showAnytime = !isMonth && firstUntimed > 0;/);
  });
});

describe("a chip is a target a thumb can hit", () => {
  it("uses the repo's 44px idiom on the chip and on the more control", () => {
    const src = calendar();
    // `touch:min-h-11` rather than a fixed height, for the reason ui/input.tsx
    // gives: min-height wins over height whatever order the utilities land in.
    expect((src.match(/touch:min-h-11/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it("lets the client name shrink instead of widening the chip", () => {
    const src = calendar();
    // The wrapper between the flex row and the truncating lines is the item
    // that has to be allowed to shrink — see
    // tests/a-flex-row-as-wide-as-its-longest-word.test.ts, which checks this
    // as a rule over the whole app. Pinned here too because this chip is the
    // narrowest box in the product: seven of them across a 570px pane.
    expect(src).toMatch(/<span className="min-w-0 flex-1">/);
  });
});

describe("what kind of work the chip says it is", () => {
  // Owner QA, 2026-08-19: the week view should read like Jobber's, whose chip
  // carries the SERVICE on line two. HoundStack has no service name — no
  // services table, no per-visit service column — because it sells one service
  // at a cadence. So "wire the service name through" had no name to wire, and
  // what these pin is the honest substitute plus the reason it sits where it
  // does. A future reader who goes looking for services(name) should find this
  // rather than the absence.

  it("has no invented service name on the chip", () => {
    const src = calendar();
    // The failure mode this guards is a literal: putting "Pet waste removal"
    // on every chip is seven identical words per row and no information.
    expect(src).not.toMatch(/Pet waste removal/i);
  });

  it("builds the label from the cadence, which is the value that exists", () => {
    const src = calendar();
    expect(src).toMatch(/const serviceLabel = \(v: CalendarVisit\) =>/);
    for (const f of ["weekly", "biweekly", "twice_weekly", "monthly", "one_time"]) {
      expect(src, `${f} is missing from FREQUENCY_LABEL`).toMatch(
        new RegExp(`\\b${f}: "`),
      );
    }
    // Every member of public.service_frequency, so an unmapped enum value
    // cannot fall through to the raw snake_case string on screen.
    const table = src.slice(src.indexOf("const FREQUENCY_LABEL"));
    expect(table.slice(0, table.indexOf("};")).match(/^\s+\w+: "/gm) ?? []).toHaveLength(5);
  });

  it("and the server actually sends the two columns it is built from", () => {
    // The label is composed in the browser, so a select that stops asking for
    // account_type degrades it silently to a bare cadence rather than erroring.
    const fn = readFileSync(join(root, "src/lib/visits.functions.ts"), "utf8");
    const q = fn.slice(fn.indexOf("export const listVisitsForDay"));
    expect(q.slice(0, q.indexOf(".eq(\"organization_id\""))).toMatch(
      /subscriptions\(price_cents, account_type, frequency,/,
    );
  });

  it("puts the cadence in the hover card and only the exception on the chip", () => {
    const src = calendar();
    // The whole judgement, pinned: cadence is a property of the CUSTOMER and
    // is the same every week, so it cannot earn space in a 96px column at the
    // cost of the street. A one-time job among recurring ones is the thing a
    // dispatcher plans around, and it is the only part promoted to the chip.
    expect(src).toMatch(/visit\.subscriptions\?\.frequency === "one_time" \? "One-time" : null/);
    expect(src).toMatch(/\[mins == null \? null : clock\(mins\), oneTime, street\]/);

    const card = src.slice(src.indexOf("<HoverCardContent"));
    expect(card.slice(0, card.indexOf("</HoverCardContent>"))).toMatch(
      /<dt className="text-muted-foreground">Service<\/dt>/,
    );
  });
});
