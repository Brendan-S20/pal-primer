// gaps-r2-06: Change sitter opened on "Not assigned" over a stay that had a
// sitter, offered every member of staff, and moved the nights the moment a
// name was picked. It now opens on the current sitter, offers staff who run
// routes, and asks first with a sentence that says which nights move.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { sitterChangeSentence, sitterOptions } from "@/lib/stay-sitter-change";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const section = readFileSync(join(ROOT, "src/components/client-detail/StaysSection.tsx"), "utf8");

const nights = (from: string, statuses: string[]) =>
  statuses.map((status, i) => {
    const d = new Date(`${from}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + i);
    return { scheduled_on: d.toISOString().slice(0, 10), status };
  });

describe("who a stay can go to", () => {
  const staff = [
    { id: "t1", display_name: "Tech One", is_field_tech: true, active: true },
    { id: "t2", display_name: "Tech Two", is_field_tech: true, active: true },
    { id: "o1", display_name: "Office", is_field_tech: false, active: true },
    { id: "d1", display_name: "Dispatcher", is_field_tech: false, active: true },
  ];

  it("offers only staff who run routes", () => {
    expect(sitterOptions(staff, { id: null, name: null }).map((s) => s.id)).toEqual(["t1", "t2"]);
  });

  it("keeps the current sitter on the list whatever their role", () => {
    expect(sitterOptions(staff, { id: "o1", name: "Office" }).map((s) => s.id)).toEqual([
      "t1",
      "t2",
      "o1",
    ]);
  });

  it("shows the current sitter before the staff list has loaded", () => {
    expect(sitterOptions([], { id: "t1", name: "Tech One" })).toEqual([
      { id: "t1", display_name: "Tech One" },
    ]);
  });
});

describe("what the confirm says", () => {
  // Check-in Oct 30, five nights. Night 1 done, night 2 under way today.
  const visits = nights("2026-10-30", [
    "completed",
    "in_progress",
    "scheduled",
    "scheduled",
    "scheduled",
  ]);
  const base = { kind: "overnight" as const, startsOn: "2026-10-30", visits, today: "2026-10-31" };

  it("names the nights that move, as the database moves them", () => {
    expect(sitterChangeSentence({ ...base, toName: "Jordan" })).toBe("Nights 3–5 move to Jordan.");
  });

  it("one night left", () => {
    expect(sitterChangeSentence({ ...base, today: "2026-11-03", toName: "Jordan" })).toBe(
      "Night 5 moves to Jordan.",
    );
  });

  it("taking the sitter off", () => {
    expect(sitterChangeSentence({ ...base, toName: null })).toBe("Nights 3–5 will have no sitter.");
  });

  it("a canceled night in the middle is not promised to anyone", () => {
    const gap = nights("2026-10-30", ["scheduled", "canceled", "scheduled", "scheduled"]);
    expect(
      sitterChangeSentence({ ...base, visits: gap, today: "2026-10-30", toName: "Jordan" }),
    ).toBe("Nights 1, 3 and 4 move to Jordan.");
  });

  it("drop-ins are counted with their dates", () => {
    const drops = [
      { scheduled_on: "2026-11-02", status: "scheduled" },
      { scheduled_on: "2026-11-02", status: "scheduled" },
      { scheduled_on: "2026-11-03", status: "scheduled" },
    ];
    expect(
      sitterChangeSentence({
        kind: "drop_in",
        startsOn: "2026-11-01",
        visits: drops,
        today: "2026-11-01",
        toName: "Jordan",
      }),
    ).toBe("The 3 visits from Nov 2 to Nov 3 move to Jordan.");
  });

  it("nothing left to move", () => {
    expect(sitterChangeSentence({ ...base, today: "2026-11-05", toName: "Jordan" })).toBe(
      "No visits are still to come, so none move. Jordan becomes the stay's sitter.",
    );
  });
});

describe("the Change sitter select", () => {
  const select = section.slice(section.indexOf("id={`stay-sitter-${stay.id}`}"));
  const tag = select.slice(0, select.indexOf("</select>"));

  it("is controlled by the stay's sitter, not a defaultValue applied before the list loads", () => {
    expect(tag).toContain('value={stay.assigned_staff_id ?? ""}');
    expect(tag).not.toContain("defaultValue");
  });

  it("asks before it moves anything", () => {
    const onChange = tag.slice(tag.indexOf("onChange"));
    expect(onChange.indexOf("await confirm(")).toBeGreaterThan(-1);
    expect(onChange.indexOf("await confirm(")).toBeLessThan(onChange.indexOf("sitter.mutate("));
    expect(onChange).toContain("if (ok) sitter.mutate(next)");
    expect(onChange).toContain("sitterChangeSentence(");
  });

  it("lists sitterOptions, not every member of staff", () => {
    expect(tag).toContain("sitterChoices.map(");
    expect(section).toContain("sitterOptions(staffQ.data?.staff");
  });
});
