// The route Live Activity on an Apple Watch Smart Stack and a CarPlay
// Dashboard (#454), through the small supplemental family.
//
// There is no watch app and no CarPlay app. iOS 18 draws the activity's small
// family on a paired watch, and iOS 26 on a CarPlay Dashboard, from the same
// content state the lock screen uses. Two things about those screens make
// this its own file:
//
//   1. They name the client: "Stop 2 of 7 · Margaret Okonkwo…". That was
//      Brendan's call on 2026-11-09, reversing the street-only default the
//      PR first shipped. The name is cut to fit a watch in the app, falls
//      back to the street (no house number) when the client has none, and
//      appears on these surfaces ONLY -- the lock screen's `nextStop` still
//      never carries it.
//   2. Nothing on them starts or completes a visit. No buttons, no links; a
//      tap opens My Day on the phone through the card's existing widgetURL,
//      which carries no action.
//
// What this cannot check: that iOS draws it. That needs an iPhone on iOS 18+
// with a paired Apple Watch on watchOS 11+, and the CarPlay Simulator with an
// iOS 26 device (the PR lists both).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import i18n from "@/lib/i18n";
import {
  buildRouteActivityState,
  clientShortName,
  routeChangePriority,
  SHORT_NAME_MAX,
  stopStreet,
  type RouteActivityVisit,
} from "@/lib/live-activity-state";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const ctx = (lang: string) => ({
  t: i18n.getFixedT(lang) as unknown as (k: string, o?: Record<string, unknown>) => string,
  tz: "America/Chicago",
  rtl: lang === "ar",
});

const CLIENT = "Margaret Okonkwo-Hargreaves";

/** Seven stops, the first done, the second next, each for a client with a
 *  long name. The property label is the office's own text and must not be
 *  what the short line uses. */
function day(
  name: string | null = CLIENT,
  street: string | null = "412 Elm St",
): RouteActivityVisit[] {
  const out: RouteActivityVisit[] = [];
  for (let i = 1; i <= 7; i++) {
    out.push({
      id: `v${i}`,
      status: i === 1 ? "completed" : "scheduled",
      properties: { label: "Back gate, blue house", street },
      clients: { display_name: name },
    });
  }
  out[1].eta_start = "2026-10-05T15:40:00Z";
  out[1].eta_end = "2026-10-05T16:00:00Z";
  return out;
}

const short = (display_name: string | null) =>
  clientShortName({ id: "x", status: "scheduled", clients: { display_name } });

describe("the short label for the watch and the car", () => {
  it("shows the client's name, truncated, at stop 2 of 7", () => {
    const s = buildRouteActivityState(day(), ctx("en"));
    expect(s.stopLabel).toBe("Stop 2 of 7");
    expect(s.shortStop).toBe("Margaret Okonkwo…");
    expect(s.window).toBe("10:40 AM–11:00 AM");
    // The lock screen's own line is unchanged: the property, never the client.
    expect(s.nextStop).toBe("Back gate, blue house");
    expect(s.nextStop).not.toContain("Margaret");
  });

  it("shows the client's name in every language, at every stop", () => {
    for (const lang of ["en", "es", "ar", "zh"]) {
      const visits = day("Ana López");
      for (let k = 1; k < visits.length; k++) {
        const s = buildRouteActivityState(visits, ctx(lang));
        expect(s.position).toBe(k + 1);
        expect(s.shortStop).toBe("Ana López");
        visits[k].status = "completed";
      }
    }
  });

  it("truncates a long name sensibly", () => {
    // Fits: unchanged.
    expect(short("Ana López")).toBe("Ana López");
    expect(short("A".repeat(SHORT_NAME_MAX))).toBe("A".repeat(SHORT_NAME_MAX));
    // At a whole word, a hyphen ending one, with an ellipsis.
    expect(short(CLIENT)).toBe("Margaret Okonkwo…");
    expect(short("Christopher Montgomery Smith")).toBe("Christopher…");
    // A dangling joiner is not left before the ellipsis.
    expect(short("Smith & Jones Property Management LLC")).toBe("Smith & Jones…");
    // One word longer than the limit is cut mid-word.
    expect(short("Wolfeschlegelsteinhausenberger")).toBe("Wolfeschlegelstei…");
    // Whitespace collapsed before it is measured.
    expect(short("  Ana    López ")).toBe("Ana López");
    // Code points, so nothing is split in half.
    expect(short("张伟明张伟明张伟明张伟明张伟明张伟明张伟明")).toBe(
      "张伟明张伟明张伟明张伟明张伟明张伟…",
    );
    for (const n of [CLIENT, "Smith & Jones Property Management LLC", "x".repeat(60)]) {
      expect(Array.from(short(n) ?? "").length).toBeLessThanOrEqual(SHORT_NAME_MAX);
    }
    // An embedded row that arrives as a one-element array reads the same.
    expect(
      clientShortName({ id: "x", status: "scheduled", clients: [{ display_name: "Ana López" }] }),
    ).toBe("Ana López");
  });

  it("falls back to the street, with no house number, when the client has no name", () => {
    for (const none of [null, "", "   "]) {
      const s = buildRouteActivityState(day(none), ctx("en"));
      expect(s.shortStop).toBe("Elm St");
    }
    // Never to the office's property label.
    expect(buildRouteActivityState(day(null, null), ctx("en")).shortStop).toBeNull();
  });

  it("is null when the route is finished", () => {
    const v = day().map((x) => ({ ...x, status: "completed" }));
    expect(buildRouteActivityState(v, ctx("en")).shortStop).toBeNull();
  });

  it("drops the house and unit numbers from the street fallback", () => {
    const cases: Array<[string, string | null]> = [
      ["412 Elm St", "Elm St"],
      ["12B Main Street", "Main Street"],
      ["1200-1204 Oak Ave", "Oak Ave"],
      ["#7 Birch Rd", "Birch Rd"],
      ["88 Birch Ave, Apt 3", "Birch Ave"],
      ["  5   North   Rd ", "North Rd"],
      ["412 5th Ave", "5th Ave"],
      ["North Rd", "North Rd"],
      ["Calle Mayor 12", "Calle Mayor 12"],
      ["412", null],
    ];
    for (const [street, want] of cases) {
      expect(stopStreet({ id: "x", status: "scheduled", properties: { street } })).toBe(want);
    }
  });

  it("the server push loads the client's display name, so a push says the same", () => {
    expect(read("src/lib/push-liveactivity.server.ts")).toMatch(
      /eta_start, eta_end, clients\(display_name\), properties\(/,
    );
    expect(read("src/lib/my-day.functions.ts")).toMatch(/clients\(display_name/);
  });

  it("a new name alone is a change worth sending", () => {
    const a = buildRouteActivityState(day(), ctx("en"));
    const b = { ...a, shortStop: "Ana López" };
    expect(routeChangePriority(a, b)).toBe(5);
    expect(routeChangePriority(a, { ...a })).toBeNull();
  });
});

describe("the widget's small family", () => {
  const view = read("ios/App/RouteActivity/RouteLiveActivity.swift");
  const code = codeOnly(view);
  const attrs = codeOnly(read("ios/App/App/LiveActivity/RouteActivityAttributes.swift"));

  it("is offered on iOS 18 and later only", () => {
    expect(code).toMatch(/\.smallSupplementalFamilyIfAvailable\(\)/);
    expect(code).toMatch(
      /if #available\(iOS 18\.0, \*\) \{\s*return supplementalActivityFamilies\(\[\.small\]\)\s*\} else \{\s*return self\s*\}/,
    );
    // The family is read only behind the same guard.
    expect(code).toMatch(/@available\(iOS 18\.0, \*\)\s*private struct FamilySwitch/);
    expect(code).toMatch(/case \.small:\s*SmallRouteView\(state: state\)/);
    expect(code).toMatch(
      /default:\s*LockScreenView\(title: title, routeDate: routeDate, state: state\)/,
    );
  });

  it("has no buttons and no links: a tap is the card's widgetURL, which has no action", () => {
    const small = code.slice(
      code.indexOf("struct SmallRouteView"),
      code.indexOf("private struct ActionButtons"),
    );
    expect(small.length).toBeGreaterThan(200);
    expect(small).not.toMatch(
      /Button|Link|intent|actionURL|directionsURL|widgetURL|StartStopIntent/,
    );
    expect(small).toMatch(/"\\\(state\.stopLabel\) · \\\(who\)"/);
    expect(small).not.toMatch(/nextStop/);
    // The card's tap target: My Day on the stop, never with an action.
    expect(attrs).toMatch(
      /func cardURL\(routeDate: String\) -> URL\? \{\s*RouteLinks\.myDay\(routeDate: routeDate, visitId: allDone \? nil : visitId\)\s*\}/,
    );
  });

  it("leaves the lock screen and the Dynamic Island as they were", () => {
    expect(code).toMatch(
      /LockScreenView[\s\S]*ActionButtons\(routeDate: routeDate, state: state\)/,
    );
    expect(code).toMatch(/DynamicIslandExpandedRegion\(\.bottom\)[\s\S]*ActionButtons\(/);
    expect(code).toMatch(
      /\.widgetURL\(context\.state\.cardURL\(routeDate: context\.attributes\.routeDate\)\)/,
    );
  });

  it("has an Xcode preview, Debug only", () => {
    const tail = view.slice(view.lastIndexOf("#if DEBUG"));
    expect(tail).toMatch(/struct SmallRouteView_Previews: PreviewProvider/);
    expect(tail).toMatch(/Stop \\\(position\) of 7/);
    expect(tail.trim().endsWith("#endif")).toBe(true);
  });

  it("carries shortStop in the Swift state, decoded forgivingly", () => {
    expect(attrs).toMatch(/public var shortStop: String\?/);
    expect(attrs).toMatch(
      /shortStop = Self\.nonEmpty\(try\? c\.decodeIfPresent\(String\.self, forKey: \.shortStop\)\)/,
    );
  });
});
