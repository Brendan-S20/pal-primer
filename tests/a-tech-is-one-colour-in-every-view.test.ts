import { describe, expect, it, vi } from "vitest";

// Leaflet touches `window` at import; same stub as the other RouteMap tests.
vi.mock("leaflet", () => ({
  default: {
    Icon: { Default: { prototype: {}, mergeOptions: () => {} } },
  },
}));

import { techColorMap } from "@/components/RouteMap";

// Riley was blue in Week and red in Month (persona review, 2026-09-27). A
// tech's colour was handed out in order among the techs who had visits in the
// window, so anyone earlier in the staff list with an empty week shifted
// everyone after them. The page says a colour means one person.

const staff = [
  { id: "sam", display_name: "Sam" },
  { id: "jo", display_name: "Jo" },
  { id: "riley", display_name: "Riley" },
];
const visit = (id: string, who: string | null, day = "2026-09-29") =>
  ({ id, assigned_staff_id: who, scheduled_on: day, latitude: 40, longitude: -74 }) as any;

describe("a tech's colour does not depend on the window", () => {
  it("Riley keeps one colour whether or not Jo has work this week", () => {
    const month = techColorMap([visit("1", "sam"), visit("2", "jo"), visit("3", "riley")], staff);
    const week = techColorMap([visit("1", "sam"), visit("3", "riley")], staff);
    expect(week.get("riley")).toBe(month.get("riley"));
    expect(week.get("sam")).toBe(month.get("sam"));
  });

  it("different techs still get different colours", () => {
    const m = techColorMap([visit("1", "sam"), visit("2", "jo"), visit("3", "riley")], staff);
    expect(new Set(m.values()).size).toBe(3);
  });
});
