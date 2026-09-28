// From the product review of 2026-09-27, Settings → Scheduling at 360px.
//
// ── SELECTED WAS A TINT ──────────────────────────────────────────────────
//
// The seven work-day pills drew a selected day as `bg-primary/10` with
// primary text, and an unselected one as a bordered pill with grey text. On
// a phone outdoors those are the same pill. The control's whole job is to
// answer "which days do we work", and it could not be read at a glance.
// Selected is now filled primary with primary-foreground text. aria-pressed
// was already there and stays: it is what a screen reader gets, and the fill
// is what everybody else gets.
//
// ── THE DEFAULT IS NOT THIS FILE'S TO CHANGE ─────────────────────────────
//
// The review also asked for a new org to default to Mon–Fri rather than all
// seven days, in app code. The default a new org gets is not in app code: it
// is the column default in 20260719110000_org-work-days.sql,
// `work_days integer[] NOT NULL DEFAULT '{0,1,2,3,4,5,6}'`. The
// `?? [0, 1, 2, 3, 4, 5, 6]` in settings.scheduling.tsx is a fallback for a
// null the NOT NULL column cannot return, and it mirrors the column on
// purpose: were it Mon–Fri, the picker would show five days selected while
// the scheduler used seven. So that is left alone here and reported, and
// this file pins the pair as they stand: a Mon–Fri edit to the app-side
// fallback alone fails here, and says where the real default lives.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");

describe("a selected work day", () => {
  const src = read("src/components/schedule/WorkDaysPicker.tsx");

  it("is filled with the primary colour, not tinted with it", () => {
    expect(src).toMatch(
      /selected\.has\(d\)\s*\?\s*"border-primary bg-primary font-medium text-primary-foreground"/,
    );
    expect(src).not.toMatch(/bg-primary\/10/);
  });

  it("says so to assistive technology as well", () => {
    expect(src).toMatch(/aria-pressed=\{selected\.has\(d\)\}/);
  });

  it("keeps the touch floor on both axes", () => {
    expect(src).toMatch(/touch:min-h-11 touch:min-w-11/);
  });
});

describe("the settings fallback agrees with the column default", () => {
  it("both are all seven days, until a migration changes them together", () => {
    const migration = read("supabase/migrations/20260719110000_org-work-days.sql");
    expect(migration).toMatch(/work_days integer\[\] NOT NULL DEFAULT '\{0,1,2,3,4,5,6\}'/);
    const settings = read("src/routes/_authenticated/settings.scheduling.tsx");
    expect(settings).toMatch(
      /\(settings\.work_days as number\[\] \| null\) \?\? \[0, 1, 2, 3, 4, 5, 6\]/,
    );
  });
});
