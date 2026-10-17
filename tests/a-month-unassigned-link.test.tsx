import { describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactNode, type ReactElement } from "react";

// Inspect the rendered element tree and call its button handlers without a DOM.
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useState: (initial: unknown) => [initial, vi.fn()],
}));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgTimezone: () => "America/Chicago" }));

import { ScheduleCalendar, type CalendarVisit } from "@/components/schedule/ScheduleCalendar";

function findLink(node: ReactNode, date: string): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findLink(child, date);
      if (found) return found;
    }
  } else if (isValidElement<Record<string, unknown>>(node)) {
    if (node.type === "button" && node.props["data-unassigned-link"] === date) return node;
    return findLink(node.props.children as ReactNode, date);
  }
}

const visit = (id: string, date: string, staff: string | null): CalendarVisit => ({
  id,
  scheduled_on: date,
  status: "scheduled",
  sequence: null,
  assigned_staff_id: staff,
});

describe("Month unassigned links", () => {
  it("passes the clicked cell's day to the unassigned handler", () => {
    const pickDay = vi.fn();
    const pickUnassigned = vi.fn();
    const tree = ScheduleCalendar({
      day: "2026-10-01",
      range: "month",
      visits: [visit("a", "2026-10-16", null), visit("b", "2026-10-16", null), visit("c", "2026-10-17", "staff")],
      techColors: new Map(),
      onPickDay: pickDay,
      onPickUnassigned: pickUnassigned,
      onOpenVisit: vi.fn(),
    });
    const link = findLink(tree, "2026-10-16");
    expect(link).toBeDefined();
    expect(link!.props.children).toEqual([2, " unassigned"]);
    (link!.props.onClick as () => void)();
    expect(pickUnassigned).toHaveBeenCalledExactlyOnceWith("2026-10-16");
    expect(pickDay).not.toHaveBeenCalled();
    expect(findLink(tree, "2026-10-17")).toBeUndefined();
  });

  it("opens the day when no separate unassigned handler is supplied", () => {
    const pickDay = vi.fn();
    const tree = ScheduleCalendar({
      day: "2026-10-01",
      range: "month",
      visits: [visit("a", "2026-10-16", null)],
      techColors: new Map(),
      onPickDay: pickDay,
      onOpenVisit: vi.fn(),
    });
    (findLink(tree, "2026-10-16")!.props.onClick as () => void)();
    expect(pickDay).toHaveBeenCalledExactlyOnceWith("2026-10-16");
  });
});
