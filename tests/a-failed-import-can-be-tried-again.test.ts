// #569: an import whose client inserts were all refused sat on "Committing"
// for ever, with 0 rows, no error and no retry. A commit now ends "failed"
// with its reason; a claim nobody finished is shown as failed after an hour;
// and "Try again" is offered only when the first attempt wrote nothing.
import { describe, expect, it } from "vitest";
import {
  commitRefusal,
  commitStalled,
  IMPORT_COMMIT_STALL_MS,
  importDisplayStatus,
  previewStats,
  refusalMessage,
  retryRefusal,
} from "@/lib/import-commit-guard";

const now = Date.parse("2026-10-28T14:00:00Z");
const at = (msAgo: number) => new Date(now - msAgo).toISOString();
const preview = {
  status: "previewing",
  entity: "clients",
  created_at: at(10 * 60 * 1000),
  stats: { total: 12, create: 12, update: 0, skip: 0, errors: 0 },
};

describe("a commit that never finished", () => {
  it("reads committing while it may still be running, and failed once it cannot be", () => {
    const running = { ...preview, commit_started_at: at(5 * 60 * 1000) };
    expect(importDisplayStatus(running, now)).toBe("committing");
    expect(commitRefusal(running, now)).toBe("committing");

    const stopped = { ...preview, commit_started_at: at(IMPORT_COMMIT_STALL_MS + 1) };
    expect(commitStalled(stopped, now)).toBe(true);
    expect(importDisplayStatus(stopped, now)).toBe("failed");
    expect(commitRefusal(stopped, now)).toBe("failed");
    expect(refusalMessage("failed")).toBe("This import did not finish.");
  });

  it("does not call a finished or unclaimed batch stalled", () => {
    expect(commitStalled(preview, now)).toBe(false);
    expect(
      commitStalled({ ...preview, status: "committed", commit_started_at: at(1e9) }, now),
    ).toBe(false);
  });
});

describe("try again", () => {
  const failed = {
    ...preview,
    status: "failed",
    commit_started_at: at(60_000),
    error: "These account fields can only be changed by the platform.",
    stats: { ...preview.stats, created: 0, updated: 0, failed: 12, skipped: 0 },
  };

  it("is offered when the failed commit wrote nothing", () => {
    expect(retryRefusal(failed, false, now)).toBeNull();
  });

  it("is refused when anything went in", () => {
    expect(retryRefusal({ ...failed, stats: { ...failed.stats, created: 3 } }, false, now)).toMatch(
      /Some rows went in/,
    );
    expect(retryRefusal({ ...failed, stats: { ...failed.stats, updated: 1 } }, false, now)).toMatch(
      /Some rows went in/,
    );
    expect(retryRefusal(failed, true, now)).toMatch(/Some rows went in/);
  });

  it("is refused for a batch that did not fail", () => {
    expect(retryRefusal(preview, false, now)).toMatch(/did not finish/);
    expect(retryRefusal({ ...preview, status: "committed" }, false, now)).toMatch(/did not finish/);
  });

  it("retries a stalled clients file only when nothing in it could have been written unseen", () => {
    const stalled = { ...preview, commit_started_at: at(IMPORT_COMMIT_STALL_MS + 1) };
    expect(retryRefusal(stalled, false, now)).toBeNull();
    expect(retryRefusal(stalled, true, now)).toMatch(/Some rows went in/);
    expect(retryRefusal({ ...stalled, entity: "balances" }, false, now)).toMatch(
      /not possible to tell/,
    );
    expect(
      retryRefusal({ ...stalled, stats: { ...preview.stats, update: 2 } }, false, now),
    ).toMatch(/not possible to tell/);
  });

  it("puts back the preview's counts and drops the commit's", () => {
    expect(previewStats(failed.stats)).toEqual(preview.stats);
    expect(previewStats(null)).toEqual({});
  });
});
