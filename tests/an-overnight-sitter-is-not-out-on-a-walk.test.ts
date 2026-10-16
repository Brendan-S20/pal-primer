// An overnight sitter is not out on a walk that evening (#411 review, item
// 7). The rule, the warning the office reads, and where it is asked. The
// database half is tests/integration/stay-clashes.db.test.ts.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { overnightClashSentence, overnightCovers, type OvernightClash } from "@/lib/stays";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const sql = read("supabase/migrations/20261017030000_an-overnight-sitter-is-not-out-on-a-walk.sql");

describe("what an overnight covers", () => {
  const night = "2026-12-24";
  it("the evening from the arrival window on", () => {
    expect(overnightCovers(night, "19:00", night, "18:00", "20:00")).toBe(true);
    expect(overnightCovers(night, "19:00:00", night, "21:00:00", "22:00:00")).toBe(true);
    // Done by the time the sitter is due.
    expect(overnightCovers(night, "19:00", night, "17:00", "19:00")).toBe(false);
    expect(overnightCovers(night, "19:00", night, "12:00", "13:00")).toBe(false);
  });

  it("the next morning before 8 AM", () => {
    expect(overnightCovers(night, "19:00", "2026-12-25", "07:00", "07:30")).toBe(true);
    expect(overnightCovers(night, "19:00", "2026-12-25", "08:00", "09:00")).toBe(false);
    expect(overnightCovers(night, "19:00", "2026-12-26", "06:00", "07:00")).toBe(false);
  });

  it("a visit with no window never clashes", () => {
    expect(overnightCovers(night, "19:00", night, null, null)).toBe(false);
  });

  it("the database draws the same line at 8 AM", () => {
    expect(sql).toMatch(/_earliest < time '08:00'/);
    expect(sql).toMatch(/COALESCE\(_latest, _earliest\) > _arrival/);
  });
});

describe("the office's warning", () => {
  const clash: OvernightClash = {
    sitter_name: "Dana",
    night_of: "2026-12-24",
    arrival: "19:00:00",
    visit_on: "2026-12-24",
    visit_earliest: "18:00:00",
    visit_latest: "20:00:00",
    client_name: "Lopez",
  };

  it("names the sitter, the night and the visit", () => {
    expect(overnightClashSentence([clash])).toBe(
      "Dana has an overnight stay the night of Thu, Dec 24, arriving from 7 PM. Their visit for Lopez on Thu, Dec 24, 6 PM to 8 PM, falls inside it.",
    );
  });

  it("counts the rest, and says nothing when nothing clashes", () => {
    expect(overnightClashSentence([clash, clash, clash])).toMatch(/ 2 more visits do too\.$/);
    expect(overnightClashSentence([clash, clash])).toMatch(/ 1 more visit does too\.$/);
    expect(overnightClashSentence([])).toBeNull();
    expect(overnightClashSentence(null)).toBeNull();
  });
});

describe("where the office is warned", () => {
  it("after booking, confirming, changing a stay or its sitter", () => {
    const stays = read("src/lib/stays.functions.ts");
    expect(stays.match(/overnightClashWarning\(supabase, \{ stayId/g)).toHaveLength(3);
    expect(read("src/lib/stay-booking.functions.ts")).toMatch(
      /clash: await overnightClashWarning\(context\.supabase, \{ stayId: data\.stayId \}\)/,
    );
  });

  it("after assigning or moving visits, one at a time or in bulk", () => {
    const visits = read("src/lib/visits.functions.ts");
    expect(visits.match(/clash: await overnightClashWarning\(/g)).toHaveLength(4);
  });

  it("the screens show it", () => {
    for (const f of [
      "src/components/VisitDetailDrawer.tsx",
      "src/components/client-detail/VisitsTab.tsx",
      "src/components/client-detail/StaysSection.tsx",
      "src/components/client-detail/ConfirmStayButton.tsx",
      "src/routes/_authenticated/routes.tsx",
    ])
      expect(read(f), f).toMatch(/toast\.warning\(r\.clash\)|afterAction\([^)]*r\.clash\)/);
  });
});
