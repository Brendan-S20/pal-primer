// The zone drawer's map toolbar, rendered inside a <form>, has no submit
// button in it (#448).
//
// Picking Polygon, Radius or Drive time, or pressing Undo or Clear, saved the
// zone and closed the drawer, because each was a <button> with no type inside
// the drawer's form. The static rule in a-button-in-a-form-says-what-it-does
// names the line; this renders the real component the way the drawer does and
// reads the markup a browser gets, in both toolbar layouts (polygon mode adds
// Undo and Clear). A click on a type="button" never submits its form, which is
// the whole of the fix; the click itself is driven in a browser by
// tests/viewports/a-mode-button-saved-the-zone.spec.ts.

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ZoneCoverageMap, type CoverageValue } from "@/components/ZoneCoverageMap";

const base: CoverageValue = {
  mode: "radius",
  polygon: null,
  centerLat: 42.5,
  centerLng: -83.15,
  radiusMeters: 1600,
  driveTimeMinutes: null,
};

function buttonsInForm(initial: CoverageValue) {
  const html = renderToStaticMarkup(
    createElement(
      "form",
      null,
      createElement(ZoneCoverageMap, { initial, onChange: () => {}, height: 300 }),
    ),
  );
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    type: /\btype="([^"]+)"/.exec(m[1])?.[1] ?? null,
    label: m[2].replace(/<[^>]+>/g, "").trim(),
  }));
}

describe("the zone coverage toolbar inside the drawer form", () => {
  it("in radius mode: Polygon, Radius and Drive time are plain buttons", () => {
    const buttons = buttonsInForm(base);
    expect(buttons.map((b) => b.label)).toEqual(["Polygon", "Radius", "Drive time"]);
    for (const b of buttons) expect(b, `${b.label} would submit the form`).toMatchObject({ type: "button" });
  });

  it("in polygon mode: Undo and Clear are plain buttons too", () => {
    const buttons = buttonsInForm({ ...base, mode: "polygon" });
    expect(buttons.map((b) => b.label)).toEqual(["Polygon", "Radius", "Drive time", "Undo", "Clear"]);
    for (const b of buttons) expect(b, `${b.label} would submit the form`).toMatchObject({ type: "button" });
  });

  it("standalone, the Save coverage button does not submit a form it lands in either", () => {
    const html = renderToStaticMarkup(
      createElement("form", null, createElement(ZoneCoverageMap, { initial: base, onSave: () => {} })),
    );
    const save = /<button\b([^>]*)>(?:(?!<\/button>)[\s\S])*Save coverage/.exec(html);
    expect(save?.[1]).toContain('type="button"');
  });
});
