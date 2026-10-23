import { describe, expect, it } from "vitest";
import {
  EXPIRY_NOTICE_DAYS,
  LESSON_REQUEST_REFUSALS,
  daysUntil,
  dueNotices,
  lessonRequestBlock,
  lessonRequestRefusal,
  officeNoticeText,
  portalShowsTraining,
} from "../src/lib/training-portal";

const pack = {
  id: "pack-1",
  sessions_count: 6,
  sessions_used: 5,
  expires_on: null as string | null,
  status: "active" as "active" | "canceled",
};

describe("which notices a package is due", () => {
  it("tells one session left once a used session leaves one, keyed by the package", () => {
    expect(dueNotices(pack, "2026-10-16")).toEqual([
      { kind: "one_left", key: "training-one-left:pack-1" },
    ]);
    // Six left of six: not yet. And a one-session package is not "one left" before it is used.
    expect(dueNotices({ ...pack, sessions_used: 0 }, "2026-10-16")).toEqual([]);
    expect(dueNotices({ ...pack, sessions_count: 1, sessions_used: 0 }, "2026-10-16")).toEqual([]);
  });

  it("tells expiry from 14 days out, keyed by the expiry date so an extension is told again", () => {
    const p = { ...pack, sessions_used: 2 };
    expect(dueNotices({ ...p, expires_on: "2026-10-31" }, "2026-10-16")).toEqual([]);
    expect(dueNotices({ ...p, expires_on: "2026-10-30" }, "2026-10-16")).toEqual([
      { kind: "expiring", key: "training-expiring:pack-1:2026-10-30" },
    ]);
    expect(dueNotices({ ...p, expires_on: "2026-10-16" }, "2026-10-16")).toHaveLength(1);
    expect(dueNotices({ ...p, expires_on: "2026-11-30" }, "2026-11-20")[0].key).toBe(
      "training-expiring:pack-1:2026-11-30",
    );
    expect(EXPIRY_NOTICE_DAYS).toBe(14);
  });

  it("tells nothing on a canceled, expired or used-up package", () => {
    expect(dueNotices({ ...pack, status: "canceled" }, "2026-10-16")).toEqual([]);
    expect(dueNotices({ ...pack, expires_on: "2026-10-15" }, "2026-10-16")).toEqual([]);
    expect(
      dueNotices({ ...pack, sessions_used: 6, expires_on: "2026-10-20" }, "2026-10-16"),
    ).toEqual([]);
  });

  it("counts days on the calendar, not the clock", () => {
    expect(daysUntil("2026-10-16", "2026-10-30")).toBe(14);
    expect(daysUntil("2026-03-01", "2026-03-15")).toBe(14);
    expect(daysUntil("2026-10-16", "2026-10-15")).toBe(-1);
  });

  it("words the office notice with the client and the package", () => {
    expect(
      officeNoticeText("expiring", {
        clientName: "Ana",
        packageName: "6-session package",
        left: 2,
        expiresOn: "2026-10-30",
      }),
    ).toEqual({
      title: "Training package expiring: Ana",
      body: "6-session package expires on 2026-10-30, with 2 sessions left.",
    });
    expect(
      officeNoticeText("one_left", {
        clientName: "Ana",
        packageName: "P",
        left: 1,
        expiresOn: null,
      }).title,
    ).toBe("One session left: Ana");
  });
});

describe("when the portal offers a lesson request", () => {
  const p = { ...pack, sessions_used: 2 };
  it("offers it while a session is free once booked lessons and open requests are counted", () => {
    expect(lessonRequestBlock(p, 3, 0, "2026-10-16")).toBeNull();
    expect(lessonRequestBlock(p, 3, 2, "2026-10-16")).toBeNull();
    expect(lessonRequestBlock(p, 4, 2, "2026-10-16")).toBe("no_sessions_left");
    expect(lessonRequestBlock(p, 6, 0, "2026-10-16")).toBe("no_sessions_left");
  });
  it("refuses a canceled or expired package", () => {
    expect(lessonRequestBlock({ ...p, status: "canceled" }, 0, 0, "2026-10-16")).toBe(
      "package_canceled",
    );
    expect(lessonRequestBlock({ ...p, expires_on: "2026-10-15" }, 0, 0, "2026-10-16")).toBe(
      "package_expired",
    );
  });
  it("words every refusal the database raises, and nothing else as one of them", () => {
    for (const code of Object.keys(LESSON_REQUEST_REFUSALS))
      expect(lessonRequestRefusal(`ERROR: ${code}`)).toBe(LESSON_REQUEST_REFUSALS[code]);
    expect(lessonRequestRefusal("connection reset")).toMatch(/could not be sent/);
    expect(Object.values(LESSON_REQUEST_REFUSALS).join(" ")).not.toMatch(/_/);
  });
});

describe("who the Training page is for", () => {
  it("is a client with a package, or one whose business runs training and sells a package", () => {
    expect(portalShowsTraining({ hasPackage: true, runsTraining: false, forSale: 0 })).toBe(true);
    expect(portalShowsTraining({ hasPackage: false, runsTraining: true, forSale: 2 })).toBe(true);
    expect(portalShowsTraining({ hasPackage: false, runsTraining: true, forSale: 0 })).toBe(false);
    expect(portalShowsTraining({ hasPackage: false, runsTraining: false, forSale: 3 })).toBe(false);
  });
});
