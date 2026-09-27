import { describe, expect, it, vi } from "vitest";

// Leaflet touches `window` at import; same stub as the other RouteMap test.
vi.mock("leaflet", () => ({
  default: {
    Icon: { Default: { prototype: {}, mergeOptions: () => {} } },
  },
}));

import { buildTechGroups, legendEntries } from "@/components/RouteMap";

// The /routes map legend keyed rows by `staffId ?? "u"`. Two real shapes of
// the day made that collide: unassigned work in two zones (two groups, both
// staffId null, both key "u") and any week or month view, where perDay splits
// one tech into a group per day and the legend listed the same name per day.
// The first surfaced as a React duplicate-key error in the E2E suite.

const v = (id: string, staff: string | null, day: string, zone: string) =>
  ({
    id,
    assigned_staff_id: staff,
    scheduled_on: day,
    zones: { name: zone },
    properties: { latitude: 42.5, longitude: -83.2 },
  }) as any;

const staff = [{ id: "s1", display_name: "Sam" }];

describe("the map legend has one row per thing on the map", () => {
  it("unassigned work in two zones is two rows with two keys", () => {
    const groups = buildTechGroups(
      [v("a", null, "2026-09-26", "Downtown"), v("b", null, "2026-09-26", "Westside")],
      staff,
    );
    expect(groups.filter((g) => g.staffId === null)).toHaveLength(2);
    const rows = legendEntries(groups);
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length);
    expect(rows.map((r) => r.name)).toEqual(["Unassigned · Downtown", "Unassigned · Westside"]);
  });

  it("a tech working five days of a week is one row, not five", () => {
    const days = ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"];
    const groups = buildTechGroups(
      days.map((d, i) => v(`v${i}`, "s1", d, "Downtown")),
      staff,
      true,
    );
    expect(groups).toHaveLength(5);
    expect(legendEntries(groups)).toEqual([
      { key: "staff:s1", name: "Sam", color: groups[0].color },
    ]);
  });
});
