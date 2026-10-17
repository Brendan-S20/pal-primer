import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { presetRange, matchingPreset, formatReportDay } from "@/lib/report-range";
import { defaultPhotoKind } from "@/lib/photo-kinds";

const read = (p: string) => readFileSync(join(import.meta.dirname, "..", p), "utf8");

describe("calendar dates lead to the work", () => {
  it("opens the selected date on the board with its unassigned column", () => {
    const calendar = read("src/components/schedule/ScheduleCalendar.tsx");
    expect(calendar).toContain('onClick={() => (onPickUnassigned ?? onPickDay)(d)}');
    const page = read("src/routes/_authenticated/routes.tsx");
    const handler = page.slice(page.indexOf('onPickUnassigned={(d)'), page.indexOf('onOpenVisit={setDetailVisitId}'));
    expect(handler).toContain('setDay(d)');
    expect(handler).toContain('setRangePersist("today")');
    expect(handler).toContain('setViewModePersist("board")');
    expect(handler).toContain('setLocalColumns(null)');
  });

  it("starts a photo as Before until work starts, including a local offline start", () => {
    expect(defaultPhotoKind("scheduled")).toBe("before");
    expect(defaultPhotoKind("scheduled", true)).toBe("completion");
    expect(defaultPhotoKind("in_progress")).toBe("completion");
    expect(defaultPhotoKind("completed")).toBe("completion");
    expect(defaultPhotoKind("missed")).toBe("before");
    const drawer = read("src/components/VisitDetailDrawer.tsx");
    expect(drawer).toContain('key={visitId!}');
    expect(drawer).toContain('defaultPhotoKind(status)');
    expect(read("src/routes/_authenticated/my-day.tsx")).toContain('defaultPhotoKind(visit.status, startedHere)');
  });
});

describe("report month presets use calendar boundaries", () => {
  it("uses month to date and the previous full month across a year boundary", () => {
    const today = new Date(2026, 0, 15);
    expect(presetRange("thisMonth", today)).toEqual({ from: "2026-01-01", to: "2026-01-15" });
    const last = { from: "2025-12-01", to: "2025-12-31" };
    expect(presetRange("lastMonth", today)).toEqual(last);
    expect(matchingPreset(last, today)).toBe("lastMonth");
    expect(matchingPreset({ from: "2025-01-01", to: "2026-01-15" }, today)).toBeNull();
  });

  it("includes leap day and exactly 30 calendar days", () => {
    expect(presetRange("lastMonth", new Date(2024, 2, 10))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    expect(presetRange("last30", new Date(2026, 9, 15))).toEqual({ from: "2026-09-16", to: "2026-10-15" });
  });

  it("formats a calendar day using the chosen locale", () => {
    for (const locale of ["en-US", "es-US", "ar", "zh-CN"]) {
      expect(formatReportDay("2026-10-01", locale)).toBe(new Date(2026, 9, 1, 12).toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }));
    }
    expect(formatReportDay("unknown", "en-US")).toBe("unknown");
  });
});
