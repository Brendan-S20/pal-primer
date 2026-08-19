// The three controls in the tenant header that a thumb could miss.
//
// ── MEASURED, NOT READ ────────────────────────────────────────────────────
//
// docs/mobile-ux-audit.md §1.1 predicted this on 2026-07-23 from reading the
// JSX: "bell and help are `p-2` around 16px icons (~32px total, below the 44px
// floor)". The bell and help were fixed. Three controls beside them were not,
// and nothing noticed for four weeks, because a parser cannot tell 32px from
// 44px — the class list is `p-2` either way and the number only exists at
// render time.
//
// The browser sweep added on 2026-08-19 measured them:
//
//   Search or jump to…   34.0px    (py-1.5 around a 20px line)
//   WeatherPopover       32.0px    (p-2 around a 16px glyph)
//   SidebarTrigger       28.0px    (h-7 w-7 from ui/sidebar.tsx)
//
// These are on EVERY tenant page, which made them the highest-leverage entry
// in a list of 22. Clearing them took the sweep from 22 failures to 21 — one
// whole surface/width combination had no other fault.
//
// ── WHY A STATIC TEST AS WELL AS THE SWEEP ────────────────────────────────
//
// CLAUDE.md states the division of labour: the browser "catches what a parser
// cannot see; the parser says where to go and fix it", and the static tests
// "run in seconds with no server". The sweep takes 4.5 minutes and needs
// Chromium. This file is the fast half — it cannot measure a pixel, but it can
// say that the specific classes carrying the size are still present, and name
// the file and line when they are not.
//
// It deliberately asserts the CLASSES rather than re-deriving the geometry,
// because re-deriving it is what the sweep is for and a second implementation
// of the arithmetic would be a second thing to get wrong.
//
// ── THE SIDEBAR TRIGGER IS THE INTERESTING ONE ────────────────────────────
//
// src/routes/platform.tsx already passed `min-h-11 min-w-11` to SidebarTrigger.
// The tenant shell — the one every customer's staff uses all day, as against
// the console only we log into — did not. So the fix existed in this repo, on
// the less important of the two shells, and had not been carried across. That
// is why the assertion below pins BOTH call sites: the failure mode is not
// "nobody knew", it is "one of two places drifted".

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are not code — the block above quotes the very classes being banned. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

describe("the tenant header's controls are all at least 44px", () => {
  const shell = codeOnly(read("src/routes/_authenticated/route.tsx"));

  it("the search button carries a minimum height, not just padding", () => {
    // `min-h-11` rather than a bigger `py-`: padding carrying the size is
    // exactly what put the Help link and the bell under the floor, and a
    // minimum survives a later change to the text size.
    const btn = shell.slice(shell.indexOf("onClick={openPalette}"));
    expect(btn.slice(0, btn.indexOf("</button>"))).toMatch(/className="flex min-h-11 /);
  });

  it("the sidebar trigger is given the size ui/sidebar.tsx does not", () => {
    // Its own default is `h-7 w-7` — 28px. The override has to come from the
    // call site, because changing the primitive would resize every trigger in
    // the app including ones inside 32px-tall bars.
    expect(shell).toMatch(/<SidebarTrigger className="min-h-11 min-w-11" \/>/);
  });

  it("and the platform shell still passes the same override, in the same words", () => {
    // The whole point of this file: the fix existed on ONE of the two shells
    // for weeks. Pinning both, spelled identically, is what stops them drifting
    // apart again — a second spelling would pass this test and still diverge.
    expect(codeOnly(read("src/routes/platform.tsx"))).toMatch(
      /<SidebarTrigger className="min-h-11 min-w-11" \/>/,
    );
  });

  it("the weather trigger is a glyph in a 44px box, like the bell beside it", () => {
    const weather = codeOnly(read("src/components/WeatherPopover.tsx"));
    const trigger = weather.slice(weather.indexOf('aria-label="Weather forecast"'));
    expect(trigger.slice(0, trigger.indexOf("</button>"))).toMatch(
      /className="flex h-11 w-11 shrink-0 items-center justify-center/,
    );
    // And the glyph is untouched, which is the point of the pattern: the header
    // looks the same, only the hit area changed.
    expect(trigger).toMatch(/<CloudSun className="h-4 w-4" \/>/);
  });

  it("no header control is sized by bare `p-2` any more", () => {
    // The shape of the original fault, stated once. `p-2` around a 16px glyph
    // is 32px, and it read as deliberate because every icon button had it.
    for (const [file, src] of [
      ["src/routes/_authenticated/route.tsx", shell],
      ["src/components/WeatherPopover.tsx", codeOnly(read("src/components/WeatherPopover.tsx"))],
    ] as const) {
      const header = src.slice(0, src.indexOf("</header>") + 1 || src.length);
      expect(header, `${file} still sizes a header control with p-2`).not.toMatch(
        /className="[^"]*\brounded-md p-2\b[^"]*"/,
      );
    }
  });
});
