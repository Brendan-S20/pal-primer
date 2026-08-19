// Two complaints about the schedule map, and the one rule that decides both.
//
// QA, in the owner's words: "including functions like scrolling to zoom in and
// out should be a basic function. Also a location to show the current
// location."
//
// ── SCROLLING ─────────────────────────────────────────────────────────────
//
// The map already had `scrollWheelZoom: true`, so the wheel DID zoom. That is
// why the complaint is worth reading twice: what was reported as a missing
// feature was a feature that behaved so badly it read as broken. The map is
// docked beside the calendar on /routes and inside a card on the dashboard, so
// a person scrolling the schedule drags the pointer across it several times a
// minute, and on every crossing the page stopped moving and the map zoomed to
// somewhere in Kansas. On a trackpad, where a scroll is two fingers and arrives
// in a stream of small deltas, one crossing can cost four zoom levels.
//
// Neither "always zoom" nor "never zoom" is the answer, so the wheel is now
// gated on intent:
//
//   ctrl/⌘ + wheel always zooms   — unambiguous, and it is also what a trackpad
//                                   PINCH emits, so pinch works for free
//   a plain wheel zooms ONLY once the map has been clicked or tapped
//   otherwise the page scrolls, and a hint says what would have zoomed
//
// The hint is not decoration. A gate that silently does nothing is the same
// bug report again, filed by the next person.
//
// ── LOCATION ──────────────────────────────────────────────────────────────
//
// There was no "where am I" control at all. Adding one is easy; adding one that
// does not quietly fail is the work, because Geolocation fails in four ordinary
// ways and every one of them is invisible by default:
//
//   the user (or a policy) denied it, possibly weeks ago, and the browser now
//   refuses without ever prompting;  the device has no fix;  it timed out;  or
//   the page is not in a secure context — which is every http:// dev server
//   opened from a phone on the LAN, where `navigator.geolocation` is missing
//   outright or fails as POSITION_UNAVAILABLE, i.e. it looks like the phone's
//   fault.
//
// So this file pins the two things that would rot first: that every failure
// path returns a sentence a person can act on, and that the control is a
// control a thumb can hit.
//
// ── WHY THIS FILE MOCKS LEAFLET ───────────────────────────────────────────
//
// `npm test` runs vitest in the default NODE environment — there is no jsdom in
// this repo — and `import "leaflet"` touches `window` at module scope, so
// importing RouteMap.tsx throws before a single assertion runs. The mock below
// stands in for the three lines of Leaflet the module body actually executes at
// import time (the default-icon path fix). Nothing under test touches it: the
// functions asserted here are pure by design, and they are pure BECAUSE the
// alternative was asserting on the shape of the source text, which passes just
// as happily when the message is an empty string.

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("leaflet", () => ({
  default: {
    Icon: { Default: { prototype: {}, mergeOptions: () => {} } },
  },
}));

import {
  GEOLOCATION_PERMISSION_DENIED,
  GEOLOCATION_POSITION_UNAVAILABLE,
  GEOLOCATION_TIMEOUT,
  WHEEL_PX_PER_ZOOM,
  geolocationErrorMessage,
  geolocationUnsupportedMessage,
  normalizeWheelDelta,
  wheelZoomIntent,
} from "@/components/RouteMap";

const root = join(import.meta.dirname, "..");
/** Lazy, for the same reason the responsive sweep is: a read that throws in a
 *  `describe` body reports "no tests" rather than a failure, and during a
 *  mutation check those two look identical. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Source with comments removed.
 *
 *  Every assertion below that says "the source does NOT contain X" is aimed at
 *  code, and the comments in RouteMap.tsx quote the things they replaced —
 *  `scrollWheelZoom: true`, `getCurrentPosition` — because that is what makes
 *  them worth reading. Matching raw text would fail on the explanation of the
 *  fix. */
const codeOnly = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .map((l) => l.replace(/\s\/\/.*$/, ""))
    .join("\n");

const source = () => codeOnly(read("src/components/RouteMap.tsx"));

describe("a plain scroll over a docked map belongs to the page", () => {
  it("zooms on ctrl and on ⌘, whether or not the map has been clicked", () => {
    // ⌘ as well as ctrl: on macOS ⌘+scroll is the reflex, and a Mac user who
    // tries the documented modifier and gets nothing concludes the gate is
    // broken rather than that they held the wrong key.
    expect(wheelZoomIntent({ ctrlKey: true }, false)).toBe("zoom the map");
    expect(wheelZoomIntent({ metaKey: true }, false)).toBe("zoom the map");
    expect(wheelZoomIntent({ ctrlKey: true }, true)).toBe("zoom the map");
  });

  it("lets the page scroll when nothing says otherwise", () => {
    // THE regression this whole gate exists to prevent. If this ever returns
    // "zoom the map", the calendar beside it stops being scrollable past the
    // map, which is how the bug was reported in the first place.
    expect(wheelZoomIntent({}, false)).toBe("let the page scroll");
    expect(wheelZoomIntent({ ctrlKey: false, metaKey: false }, false)).toBe("let the page scroll");
  });

  it("still gives a plain wheel to the map once it has been armed", () => {
    // The other half of the trade. "Scrolling to zoom should be a basic
    // function" is satisfied by one click, with no modifier to remember; a gate
    // that ONLY ever accepted ctrl would be answering a different complaint.
    expect(wheelZoomIntent({}, true)).toBe("zoom the map");
  });

  it("reads wheel deltas in pixels regardless of how the browser reports them", () => {
    // deltaMode is not a formality. Firefox on Windows reports LINES (mode 1,
    // about 3 per notch) and some setups report PAGES (mode 2). Taking deltaY
    // at face value gives a map that needs twenty notches per zoom level on one
    // browser and jumps four levels on another — and the person on the slow one
    // reports "scroll to zoom doesn't work", which is this ticket again.
    const notch = normalizeWheelDelta({ deltaY: -100, deltaMode: 0 });
    const lines = normalizeWheelDelta({ deltaY: -3, deltaMode: 1 });
    const pages = normalizeWheelDelta({ deltaY: -1, deltaMode: 2 });
    for (const v of [notch, lines, pages]) {
      // Positive means zoom IN: the sign flip is deliberate, since a wheel
      // pushed forward reports a NEGATIVE deltaY.
      expect(v).toBeGreaterThan(0);
      // And each of the three is at least a zoom level's worth, so no browser
      // is left needing a fistful of notches per step.
      expect(v).toBeGreaterThanOrEqual(WHEEL_PX_PER_ZOOM * 0.7);
    }
    expect(normalizeWheelDelta({ deltaY: 100 })).toBeLessThan(0);
  });

  it("does not hand the wheel back to Leaflet's own handler", () => {
    const src = source();
    // `scrollWheelZoom: true` is what shipped, and it is a one-word edit away
    // at all times. Leaflet's handler cannot be gated — it binds its own
    // listener — so having it on at the same time means two zooms per notch.
    expect(src).not.toMatch(/scrollWheelZoom:\s*true/);
    expect(src).toMatch(/scrollWheelZoom:\s*false/);
    // Pinch is never ambiguous, so it is never gated.
    expect(src).toMatch(/touchZoom:\s*true/);
  });

  it("says something when it declines to zoom", () => {
    // A gate nobody was told about is indistinguishable from a broken wheel.
    const src = source();
    const guard = src.slice(src.indexOf('=== "let the page scroll"'));
    expect(guard.slice(0, 400)).toMatch(/showHint\(/);
    expect(src).toMatch(/Ctrl \/ ⌘ \+ scroll to zoom/);
    // …and it must not be a hover-only hint or a title attribute: the same
    // interception happens on a phone as a one-finger drag, which gets its own
    // sentence, and neither is reachable by hovering.
    expect(src).toMatch(/Tap the map to pan it/);
  });
});

describe("a location button that fails out loud", () => {
  it("has a sentence for every way Geolocation fails", () => {
    const cases = [
      { code: GEOLOCATION_PERMISSION_DENIED },
      { code: GEOLOCATION_POSITION_UNAVAILABLE },
      { code: GEOLOCATION_TIMEOUT },
      { code: 99 }, // a code the spec does not define
      null, // an error object that is not one
      undefined,
    ];
    for (const c of cases) {
      const msg = geolocationErrorMessage(c);
      // The point of the whole exercise: no empty string, no undefined, no
      // "Error", no bare code number. Something a person can read.
      expect(typeof msg).toBe("string");
      expect(msg.trim().length).toBeGreaterThan(20);
      expect(msg).not.toMatch(/undefined|\[object/i);
    }
  });

  it("tells a denied user how to undo the denial", () => {
    // The denial path is the one that must never be silent AND the one most
    // likely to be softened into "Location unavailable" by a future tidy-up.
    // "Unavailable" is a status; this has to be an instruction, because the
    // browser will not prompt again on its own.
    const msg = geolocationErrorMessage({ code: GEOLOCATION_PERMISSION_DENIED });
    expect(msg).toMatch(/permission|blocked|allow/i);
    expect(msg).toMatch(/settings/i);
    expect(msg).toMatch(/again/i);
  });

  it("does not blame http for a denial", () => {
    // Both faults produce "no location", and the temptation is one message for
    // both. Telling somebody who pressed Block to switch to https sends them to
    // fix a thing that is not broken — and, worse, it hides the one fix that
    // would have worked.
    const denied = geolocationErrorMessage(
      { code: GEOLOCATION_PERMISSION_DENIED },
      { secureContext: false },
    );
    expect(denied).not.toMatch(/https|secure connection/i);
    expect(denied).toMatch(/permission|blocked|allow/i);
  });

  it("names the http dev server when that is what is actually wrong", () => {
    // Geolocation is only exposed in a secure context. Open the dev server from
    // a phone on the LAN and it fails for a reason that has nothing to do with
    // the phone, the app, or the user's settings — so say so rather than
    // letting somebody spend an afternoon on it.
    const insecure = geolocationErrorMessage(
      { code: GEOLOCATION_POSITION_UNAVAILABLE },
      { secureContext: false },
    );
    expect(insecure).toMatch(/https|secure connection/i);
    // …and on a secure page the same code means something else entirely, so it
    // must not mention https at all.
    const secure = geolocationErrorMessage({ code: GEOLOCATION_POSITION_UNAVAILABLE });
    expect(secure).not.toMatch(/https/i);
    expect(geolocationUnsupportedMessage(false)).toMatch(/https|secure connection/i);
    expect(geolocationUnsupportedMessage(true).trim().length).toBeGreaterThan(20);
  });

  it("puts the failure on the screen instead of in the console", () => {
    const src = source();
    // A pure function that formats a message is worth nothing if the error
    // callback drops it. This is the wiring: the error arm of
    // getCurrentPosition sets the state the alert box renders.
    expect(src).toMatch(/setGeoError\(geolocationErrorMessage\(/);
    expect(src).toMatch(/setGeoError\(geolocationUnsupportedMessage\(/);
    expect(src).toMatch(/role="alert"/);
    // Not a console.error, and not a toast that has already gone by the time
    // the phone comes out of a pocket.
    expect(src).not.toMatch(/console\.(error|warn)\(/);
  });
});

describe("nothing asks for the permission before it is asked for", () => {
  /** The body of `locate`, found by matching braces from its declaration.
   *
   *  Comments are stripped first: they discuss `getCurrentPosition` by name and
   *  would otherwise both skew the brace count and satisfy the search. */
  const locateBody = () => {
    const src = source();
    const at = src.indexOf("const locate = useCallback(");
    expect(at).toBeGreaterThan(-1);
    let i = src.indexOf("{", at);
    let depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) break;
    }
    return { start: at, end: i, text: src.slice(at, i) };
  };

  it("calls getCurrentPosition from the button handler and nowhere else", () => {
    // The rule this protects: a map that prompts on mount trains people to
    // press Block, and Block is remembered for the ORIGIN. One autoloading
    // prompt costs the feature permanently for that user — there is no second
    // chance to ask nicely. So the call must live behind a press.
    const src = source();
    const { start, end } = locateBody();
    const calls: number[] = [];
    for (
      let i = src.indexOf("getCurrentPosition");
      i !== -1;
      i = src.indexOf("getCurrentPosition", i + 1)
    ) {
      calls.push(i);
    }
    // Found at all — otherwise the rest of this passes on an empty file.
    expect(calls.length).toBe(1);
    expect(calls.every((i) => i > start && i < end)).toBe(true);
  });

  it("never watches position, which is a permission prompt that also drains a battery", () => {
    expect(source()).not.toMatch(/watchPosition/);
  });

  it("touches navigator.geolocation only inside that same handler", () => {
    // Includes the feature-detect. `if (!navigator.geolocation)` in a useEffect
    // is harmless in itself, but it is one line away from becoming a call, and
    // the useEffect is exactly where somebody would put "…and locate them on
    // load, it's nicer".
    const src = source();
    const { start, end } = locateBody();
    for (
      let i = src.indexOf("navigator.geolocation");
      i !== -1;
      i = src.indexOf("navigator.geolocation", i + 1)
    ) {
      expect(i > start && i < end).toBe(true);
    }
  });

  it("is wired to a press", () => {
    expect(source()).toMatch(/onClick=\{locate\}/);
  });
});

describe("a control a thumb can hit, at every width", () => {
  it("gives the locate button the 44px box from ui/dialog.tsx", () => {
    const src = source();
    const btn = src.slice(src.indexOf("onClick={locate}"));
    const head = btn.slice(0, 700);
    // h-11/w-11 is 2.75rem = 44px. Not `h-8` with a big icon: CLAUDE.md is
    // about the BUTTON, and this one sits in a map corner where a near-miss
    // pans the map instead — the most annoying possible failure.
    expect(head).toMatch(/\bh-11\b/);
    expect(head).toMatch(/\bw-11\b/);
    expect(head).toMatch(/items-center/);
    expect(head).toMatch(/justify-center/);
    // A 16px glyph inside it, same as the dialog close button.
    expect(head).toMatch(/className="h-4 w-4/);
  });

  it("labels it for a screen reader as well as for a pointer", () => {
    const src = source();
    expect(src).toMatch(/aria-label="Show my current location"/);
    // A `title` alone is a tooltip, and a tooltip is a hover, and hover does
    // not exist on the phone this button is FOR.
    expect(src).toMatch(/aria-label="Dismiss location message"/);
  });

  it("shows the button always, never on hover", () => {
    const src = source();
    const btn = src.slice(src.indexOf("onClick={locate}"), src.indexOf("onClick={locate}") + 700);
    // `opacity-0 group-hover:opacity-100` is the usual way a map control ends
    // up unreachable on touch. Colour changes on hover are fine; appearing is
    // not.
    expect(btn).not.toMatch(/group-hover:opacity|opacity-0/);
    expect(btn).not.toMatch(/hidden\s+md:flex|md:opacity-100/);
  });

  it("keeps Leaflet's own +/- buttons hittable below md", () => {
    // 30px out of the box — the same "aim at it" target CLAUDE.md called out on
    // the tab bar, and the answer for anyone who would rather not scroll to
    // zoom at all.
    expect(source()).toMatch(/max-md:\[&_\.leaflet-control-zoom_a\]:h-11/);
    expect(source()).toMatch(/max-md:\[&_\.leaflet-control-zoom_a\]:w-11/);
  });

  it("cannot push the page sideways at 360px", () => {
    const src = source();
    // The map box is the page's width; the overlays must be bounded BY it. A
    // fixed `w-80` message box is 320px of the 360px viewport before the
    // button beside it, which is the failure CLAUDE.md names by width.
    expect(src).toMatch(/max-w-\[calc\(100%-1rem\)\]/);
    expect(src).toMatch(/max-w-\[min\(15rem,calc\(100vw-5rem\)\)\]/);
    // The message wraps inside its box instead of setting the box's width.
    expect(src).toMatch(/<span className="min-w-0">\{geoError\}<\/span>/);
    expect(src).not.toMatch(/whitespace-nowrap/);
  });

  it("does not let the hint swallow the click that follows it", () => {
    // It appears while the user is mid-scroll and mid-reach. A banner over the
    // map that eats the next tap would be a worse bug than the one it explains.
    const src = source();
    const hint = src.slice(src.indexOf("{hint && ("));
    expect(hint.slice(0, 600)).toMatch(/pointer-events-none/);
  });
});

describe("you are here is not a stop on somebody's route", () => {
  it("draws the device position in a colour no tech can be assigned", () => {
    const src = source();
    const palette = src.slice(
      src.indexOf("const TECH_COLORS"),
      src.indexOf("];", src.indexOf("const TECH_COLORS")),
    );
    const techColors = (palette.match(/#[0-9a-f]{6}/gi) ?? []).map((c) => c.toLowerCase());
    // Both halves have to be found for the comparison to mean anything. A
    // rename that empties either list would otherwise leave this green.
    expect(techColors.length).toBeGreaterThan(5);
    const dot = src.slice(src.indexOf("route-you-are-here"));
    const dotColors = (dot.slice(0, 600).match(/background:(#[0-9a-f]{6})/gi) ?? []).map((c) =>
      c.replace(/^background:/i, "").toLowerCase(),
    );
    expect(dotColors.length).toBeGreaterThan(0);
    // Asserted against the PALETTE, not against one hex literal: reaching for
    // #2563eb because it "looks like a location dot" is the obvious mistake,
    // and #2563eb is tech #1 — on a map whose entire language is "colour =
    // whose route this is", the you-are-here dot would become somebody's stop.
    for (const c of dotColors) expect(techColors).not.toContain(c);
    expect(src).toMatch(/route-you-are-here/);
  });

  it("labels it permanently rather than on hover", () => {
    const src = source();
    const marker = src.slice(src.indexOf("route-you-are-here"));
    expect(marker.slice(0, 1200)).toMatch(/permanent:\s*true/);
    expect(marker.slice(0, 1200)).toMatch(/"You are here"/);
  });

  it("keeps it out of the layer that gets cleared on every refetch", () => {
    // The visits layer is `clearLayers()`ed whenever the data changes. A
    // location that disappears on the next poll is one the owner presses twice
    // and then stops believing.
    const src = source();
    expect(src).toMatch(/meRef = useRef<L\.LayerGroup \| null>\(null\)/);
    // Checked from inside `locate`, which is the end that can be got wrong:
    // `const layer = layerRef.current` there is a one-word slip that reads
    // perfectly and loses the dot on the next poll.
    const body = source().slice(source().indexOf("const locate = useCallback("));
    const inLocate = body.slice(0, body.indexOf("\n  }, []);"));
    expect(inLocate).toMatch(/const layer = meRef\.current/);
    expect(inLocate).not.toMatch(/layerRef/);
    // And the auto-fit does not fling the viewport back off your position the
    // moment the same day refetches.
    expect(src).toMatch(/!suppressFitRef\.current/);
  });
});
