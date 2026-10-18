// A board card shows the whole address (#498).
//
// On an iPad at 1032px the dispatch board's stop cards cut the address off
// after a few words: `<div className="truncate ...">{p.street}, {p.city}
// {p.postal_code}</div>` forced one line with an ellipsis and had no tooltip,
// so on a narrow lane the city was the part that went, and stops on the same
// street could not be told apart without opening each one.
//
// The card now gives the street its own line and the city and ZIP the next,
// The street may wrap to two lines whether or not a city line follows, so the
// clamp never cuts a short street; the city and ZIP stay one truncated line.
// The full address is the wrapper's `title` for anyone with a mouse.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(process.cwd(), "src/routes/_authenticated/routes.tsx"), "utf8");
const start = src.indexOf("function VisitCardView(");
const card = src.slice(start, src.indexOf("\nfunction ", start + 1));

describe("VisitCardView's address", () => {
  it("is found", () => {
    expect(start).toBeGreaterThan(-1);
    expect(card).toMatch(/data-card-address=""/);
  });

  it("is not one truncated line any more", () => {
    // The shape that shipped, in any spacing.
    expect(card).not.toMatch(/\{p\.street\},\s*\{p\.city\}\s*\{p\.postal_code\}/);
    const wrapper = card.match(/<div data-card-address=""[^>]*>/)?.[0] ?? "";
    expect(wrapper).not.toMatch(/\btruncate\b/);
    expect(wrapper).not.toMatch(/line-clamp-1\b/);
  });

  it("puts the street and the city line on lines of their own", () => {
    expect(card).toMatch(
      /const cityLine = \[p\?\.city\?\.trim\(\), p\?\.postal_code\?\.trim\(\)\]/,
    );
    // The street may take two lines with or without a city line under it,
    // and is never a one-line truncate; the city line stays one line.
    const streetLine = card.match(/\{street && <div className=([^>]*)>\{street\}<\/div>\}/);
    expect(streetLine).not.toBeNull();
    expect(streetLine?.[1]).toMatch(/\bline-clamp-2\b/);
    expect(streetLine?.[1]).toMatch(/\bbreak-words\b/);
    expect(streetLine?.[1]).not.toMatch(/\btruncate\b/);
    expect(streetLine?.[1]).not.toMatch(/cityLine/);
    expect(card).toMatch(/\{cityLine && <div className="truncate">\{cityLine\}<\/div>\}/);
  });

  it("carries the full address as its title, with no stray comma", () => {
    expect(card).toMatch(/const full = \[street, cityLine\]\.filter\(Boolean\)\.join\(", "\)/);
    expect(card).toMatch(/<div data-card-address=""[^>]*title=\{full\}/);
    expect(card).toMatch(/if \(!full\) return null;/);
  });
});
