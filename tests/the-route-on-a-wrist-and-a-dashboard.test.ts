// The route Live Activity on an Apple Watch Smart Stack and a CarPlay
// Dashboard (#454), through the small supplemental family.
//
// There is no watch app and no CarPlay app. iOS 18 draws the activity's small
// family on a paired watch, and iOS 26 on a CarPlay Dashboard, from the same
// content state the lock screen uses. Two things about those screens make
// this its own file:
//
//   1. They are read by whoever is in the car or glances at a wrist, so the
//      stop is named by its street with no house number -- "Elm St" -- and
//      never by the office's label for the property, which is often the
//      customer's name, and never by the customer.
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
  routeChangePriority,
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

/** Seven stops, the first done, the second next. Every property is labelled
 *  with the customer's name, as offices do, and each visit carries the client
 *  record a wider query would bring along: neither may reach the short line. */
function day(
  street: (i: number) => string | null = (i) => `${400 + i} Elm St`,
): RouteActivityVisit[] {
  const out: RouteActivityVisit[] = [];
  for (let i = 1; i <= 7; i++) {
    out.push({
      id: `v${i}`,
      status: i === 1 ? "completed" : "scheduled",
      properties: { label: `${CLIENT} residence`, street: street(i) },
      // Not part of RouteActivityVisit; here to prove the builder ignores it.
      ...({ clients: { name: CLIENT, display_name: CLIENT } } as object),
    });
  }
  out[1].eta_start = "2026-10-05T15:40:00Z";
  out[1].eta_end = "2026-10-05T16:00:00Z";
  return out;
}

describe("the short label for the watch and the car", () => {
  it("is the street with no house number, at stop 2 of 7", () => {
    const s = buildRouteActivityState(day(), ctx("en"));
    expect(s.stopLabel).toBe("Stop 2 of 7");
    expect(s.shortStop).toBe("Elm St");
    expect(s.window).toBe("10:40 AM–11:00 AM");
    // The lock screen's own line is unchanged: still the office's label.
    expect(s.nextStop).toBe(`${CLIENT} residence`);
  });

  it("never contains the client's name, in any language, at any stop", () => {
    const parts = CLIENT.split(/[\s-]+/);
    for (const lang of ["en", "es", "ar", "zh"]) {
      const visits = day();
      for (let k = 0; k < visits.length; k++) {
        const s = buildRouteActivityState(visits, ctx(lang));
        for (const part of parts) {
          expect(s.shortStop ?? "").not.toContain(part);
          expect(s.stopLabel).not.toContain(part);
          expect(s.window ?? "").not.toContain(part);
        }
        visits[k].status = "completed";
      }
    }
  });

  it("is null rather than falling back to the label when the stop has no street", () => {
    const s = buildRouteActivityState(
      day(() => null),
      ctx("en"),
    );
    expect(s.nextStop).toBe(`${CLIENT} residence`);
    expect(s.shortStop).toBeNull();
    expect(
      buildRouteActivityState(
        day(() => "   "),
        ctx("en"),
      ).shortStop,
    ).toBeNull();
    expect(
      buildRouteActivityState(
        day(() => "412"),
        ctx("en"),
      ).shortStop,
    ).toBeNull();
  });

  it("is null when the route is finished", () => {
    const v = day().map((x) => ({ ...x, status: "completed" }));
    expect(buildRouteActivityState(v, ctx("en")).shortStop).toBeNull();
  });

  it("drops the house and unit numbers", () => {
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
    ];
    for (const [street, want] of cases) {
      expect(stopStreet({ id: "x", status: "scheduled", properties: { street } })).toBe(want);
    }
  });

  it("reads only the street: a label or a client is never consulted", () => {
    const src = codeOnly(read("src/lib/live-activity-state.ts"));
    const fn = src.slice(
      src.indexOf("export function stopStreet"),
      src.indexOf("export function stopDestination"),
    );
    expect(fn).toMatch(/properties\?\.street/);
    expect(fn).not.toMatch(/label|client|name/i);
  });

  it("a new street alone is a change worth sending", () => {
    const a = buildRouteActivityState(day(), ctx("en"));
    const b = { ...a, shortStop: "Birch Ave" };
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
    expect(small).toMatch(/state\.shortStop/);
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
