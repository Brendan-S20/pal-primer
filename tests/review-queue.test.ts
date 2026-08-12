import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  REVIEW_KINDS,
  REVIEW_KIND_COPY,
  REVIEW_STATUSES,
  resolutionNoteRequired,
  visitReviewKind,
  type ReviewKind,
  type ReviewableVisit,
} from "@/lib/review-queue";

// BUILD-10 — guardrail 10.5's review queue.
//
// The rule has two implementations: public.detect_review_items() decides what
// gets filed, visitReviewKind() decides what the UI calls ambiguous. If they
// disagree, the list says three and the page shows two, and nobody trusts
// either again. This replays fixtures against the TypeScript and parses the
// SQL to confirm both know the same kinds and the same predicates.
//
// The parser is strict on purpose: if the SQL is restructured into a shape it
// cannot read, this FAILS rather than passing vacuously.

const MIGRATION = join(
  __dirname,
  "..",
  "supabase",
  "migrations",
  "20260730100000_review-queue.sql",
);
const rawSql = readFileSync(MIGRATION, "utf8");
// Strip `--` comments before parsing. The migration's comments are prose and
// contain parentheses ("(the BUG-9 signature)"), which a naive [^)]* would stop
// at — silently parsing one kind instead of three and passing a weaker check
// than intended.
const sql = rawSql.replace(/--[^\n]*/g, "");

function detectorBody(source: string): string {
  const start = source.indexOf("CREATE OR REPLACE FUNCTION public.detect_review_items");
  if (start === -1) throw new Error("detect_review_items is not defined in the expected migration");
  const end = source.indexOf("$$;", start);
  if (end === -1) throw new Error("Could not find the end of the detect_review_items body");
  return source.slice(start, end);
}

/** The kinds the CHECK constraint permits. */
function kindsFromCheck(source: string): string[] {
  const m = source.match(/kind text NOT NULL CHECK \(kind IN \(([^)]*)\)/);
  if (!m) throw new Error("Could not parse the review_items kind CHECK constraint");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
}

const body = detectorBody(rawSql);

describe("TS ↔ SQL review-queue parity (BUILD-10)", () => {
  it("defines exactly the same kinds on both sides", () => {
    expect([...kindsFromCheck(sql)].sort()).toEqual([...REVIEW_KINDS].sort());
  });

  it("files every kind it permits — no kind the detector can never produce", () => {
    // A kind allowed by the constraint but never inserted is dead vocabulary
    // that makes the queue look more capable than it is.
    for (const kind of REVIEW_KINDS) {
      expect(body, `detect_review_items never files "${kind}"`).toContain(`'${kind}'`);
    }
  });

  it("uses ORG-LOCAL dates, not the database's UTC today", () => {
    // This exact mistake has now appeared three times in this codebase (the
    // portal, the weekly digest, the missed-visit sweep). A UTC boundary here
    // would flag visits for review hours before the org's day had ended.
    expect(body).toContain("AT TIME ZONE");
    expect(body).toMatch(/coalesce\(o\.timezone/);
    expect(body, "detector must not compare against a bare CURRENT_DATE").not.toMatch(
      /scheduled_on\s*<\s*CURRENT_DATE/i,
    );
  });

  it("never reopens an item a human already decided", () => {
    // The property that makes the queue trustworthy instead of nagging: the
    // underlying condition usually REMAINS true after resolution, so without
    // this the next sweep would resurrect it forever.
    expect(body).toContain("ON CONFLICT");
    expect(body).toContain("DO NOTHING");
  });

  it("keeps the detector's insert idempotent via the uniqueness key", () => {
    expect(sql).toContain("UNIQUE (organization_id, kind, subject_id)");
  });
});

const day = (d: string, over: Partial<ReviewableVisit> = {}): ReviewableVisit => ({
  status: "completed",
  scheduled_on: d,
  started_at: null,
  completed_at: null,
  ...over,
});

const TODAY = "2026-07-30";

describe("visitReviewKind (BUILD-10)", () => {
  it("flags the BUG-9 signature: completion at or before start", () => {
    const same = day("2026-07-02", {
      started_at: "2026-07-02T04:05:00Z",
      completed_at: "2026-07-02T04:05:00Z",
    });
    expect(visitReviewKind(same, TODAY)).toBe("visit_timestamps_unreliable");

    const backwards = day("2026-07-02", {
      started_at: "2026-07-02T05:00:00Z",
      completed_at: "2026-07-02T04:00:00Z",
    });
    expect(visitReviewKind(backwards, TODAY)).toBe("visit_timestamps_unreliable");
  });

  it("does NOT flag a normal visit", () => {
    const ok = day("2026-07-02", {
      started_at: "2026-07-02T14:00:00Z",
      completed_at: "2026-07-02T14:22:00Z",
    });
    expect(visitReviewKind(ok, TODAY)).toBeNull();
  });

  it("does NOT flag a visit with simply no timestamps", () => {
    // Missing is not the same as contradictory. BUG-9(a) was closed for exactly
    // this distinction — treating "unknown" as "known-bad" invents a defect.
    expect(visitReviewKind(day("2026-07-02"), TODAY)).toBeNull();
    expect(
      visitReviewKind(day("2026-07-02", { started_at: "2026-07-02T14:00:00Z" }), TODAY),
    ).toBeNull();
  });

  it("does NOT claim unparseable timestamps contradict each other", () => {
    const junk = day("2026-07-02", { started_at: "not-a-date", completed_at: "also-not" });
    expect(visitReviewKind(junk, TODAY)).toBeNull();
  });

  it("flags a past visit a tech started but never finished", () => {
    const v = day("2026-07-28", { status: "scheduled", started_at: "2026-07-28T15:00:00Z" });
    expect(visitReviewKind(v, TODAY)).toBe("visit_started_never_finished");
  });

  it("does NOT flag a scheduled visit that never started — that is an ordinary miss", () => {
    expect(visitReviewKind(day("2026-07-28", { status: "scheduled" }), TODAY)).toBeNull();
  });

  it("flags a visit left in progress after its day", () => {
    const v = day("2026-07-28", { status: "in_progress", started_at: "2026-07-28T15:00:00Z" });
    expect(visitReviewKind(v, TODAY)).toBe("visit_stuck_in_progress");
  });

  it("leaves TODAY's work alone — it is not ambiguous yet, just unfinished", () => {
    // The whole point of the org-local boundary. A tech mid-route at 4pm must
    // not have their open visit filed as a data-integrity problem.
    const inProgressToday = day(TODAY, {
      status: "in_progress",
      started_at: "2026-07-30T15:00:00Z",
    });
    expect(visitReviewKind(inProgressToday, TODAY)).toBeNull();

    const startedToday = day(TODAY, { status: "scheduled", started_at: "2026-07-30T15:00:00Z" });
    expect(visitReviewKind(startedToday, TODAY)).toBeNull();
  });

  it("leaves FUTURE work alone", () => {
    expect(visitReviewKind(day("2026-08-05", { status: "scheduled" }), TODAY)).toBeNull();
  });

  it("checks contradictory timestamps regardless of status or how old the visit is", () => {
    // A completed visit from months ago with impossible times is still
    // ambiguous; the day-has-passed gate must not swallow it.
    const old = day("2026-01-15", {
      status: "completed",
      started_at: "2026-01-15T10:00:00Z",
      completed_at: "2026-01-15T10:00:00Z",
    });
    expect(visitReviewKind(old, TODAY)).toBe("visit_timestamps_unreliable");
  });
});

describe("review-queue vocabulary (BUILD-10)", () => {
  it("has reader-facing copy for every kind", () => {
    for (const kind of REVIEW_KINDS as readonly ReviewKind[]) {
      const copy = REVIEW_KIND_COPY[kind];
      expect(copy?.label, `no label for ${kind}`).toBeTruthy();
      // "What it means" has to explain the ambiguity, not restate the label —
      // an item nobody understands is an item nobody resolves.
      expect(copy.whatItMeans.length).toBeGreaterThan(40);
      expect(copy.howToFix.length).toBeGreaterThan(10);
    }
  });

  it("requires a note for any resolution, and none to leave an item open", () => {
    expect(resolutionNoteRequired("resolved")).toBe(true);
    expect(resolutionNoteRequired("dismissed")).toBe(true);
    expect(resolutionNoteRequired("open")).toBe(false);
  });

  it("matches the status values the database permits", () => {
    const m = sql.match(/status text NOT NULL DEFAULT 'open' CHECK \(status IN \(([^)]*)\)/);
    expect(m, "could not parse the status CHECK constraint").toBeTruthy();
    const dbStatuses = [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    expect(dbStatuses.sort()).toEqual([...REVIEW_STATUSES].sort());
  });
});
