// A client hears when a walk changes (#410).
//
// Email only (client texting is Coming soon). Four moments, each for a dog
// walk and nothing else, so a pet-waste client gets exactly the emails they
// got before:
//
//   skipped     the walker skipped it (skipVisit)         walk-not-done
//   missed      the nightly job marked it missed           walk-not-done
//   moved       the office rescheduled one or many         walk-schedule-changed
//   replanned   a walk plan's days or window changed       walk-schedule-changed
//
// Each has its own switch on the business (both on by default), and the
// on-my-way email says walker and walk for a walk while every other visit's
// email stays byte for byte what it was.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { render } from "react-email";

// ── A database and an email queue the senders can be watched through ───────

const db = vi.hoisted(() => ({
  visits: [] as any[],
  subscriptions: [] as any[],
  sent: [] as any[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    const q: any = {
      select: () => q,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), q),
      gte: (col: string, v: string) => (filters.push((r) => r[col] >= v), q),
      lt: (col: string, v: string) => (filters.push((r) => r[col] < v), q),
      limit: () => q,
      // Copies, as a real read returns: a later change to the table must not
      // reach back into rows already read.
      rows: () =>
        ((db as any)[table] ?? [])
          .filter((r: any) => filters.every((f) => f(r)))
          .map((r: any) => structuredClone(r)),
      maybeSingle: async () => ({ data: q.rows()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve({ data: q.rows(), error: null }).then(res),
    };
    return q;
  };
  return { supabaseAdmin: { from } };
});

vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: async (p: any) => {
    db.sent.push(p);
    return { ok: true };
  },
}));

const { notifyWalkNotDone, notifyMissedWalks, watchWalkSchedule, notifyWalkPlanChanged, moveKey } =
  await import("@/lib/walk-notify.server");
const {
  SKIP_CODES,
  walkSkipReason,
  walkNotDoneSubject,
  weekdaysPhrase,
  walkSlotLabel,
  walkScheduleLine,
  walkPlanScheduleChanged,
} = await import("@/lib/walk-notify");
const { TEMPLATES } = await import("@/lib/email-templates/registry");
const { template: onMyWayBefore } = await import("./support/fixtures/on-my-way-before-walks");

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const WALK = { service_line: "dog_walking" };
const SCOOP = { service_line: "pet_waste" };

function visit(over: Record<string, unknown> = {}) {
  return {
    id: "v1",
    organization_id: "org-1",
    client_id: "c1",
    scheduled_on: "2026-10-19",
    status: "skipped",
    skip_reason_code: "gate_locked",
    subscription_id: "s1",
    services: WALK,
    subscriptions: { earliest_time: "10:00:00", latest_time: "12:00:00" },
    properties: { visit_contact_email: null, dogs: [{ name: "Bella", active: true }] },
    ...over,
  };
}

beforeEach(() => {
  db.visits = [];
  db.subscriptions = [];
  db.sent = [];
});

// ── The words ──────────────────────────────────────────────────────────────

describe("what the client is told", () => {
  it("every skip code reads as a sentence, and an unknown one as the general one", () => {
    for (const code of SKIP_CODES) expect(walkSkipReason(code)).toMatch(/^[A-Z].*\.$/);
    expect(walkSkipReason("something_new")).toBe(walkSkipReason("other"));
    expect(walkSkipReason(null)).toBe(walkSkipReason("other"));
  });

  it("names the dog when skipped and the day when missed", () => {
    expect(walkNotDoneSubject("skipped", "Bella", "Mon, Oct 19")).toBe(
      "We could not walk Bella today",
    );
    expect(walkNotDoneSubject("missed", "Bella", "Mon, Oct 19")).toBe(
      "Your walk on Mon, Oct 19 did not happen",
    );
  });

  it("says a day, or the days of a plan, and the window", () => {
    expect(weekdaysPhrase([5, 1, 3])).toBe("Mon, Wed and Fri");
    expect(weekdaysPhrase([2])).toBe("Tue");
    expect(weekdaysPhrase([])).toBeNull();
    expect(walkSlotLabel({ day: "2026-10-19", earliest: "10:00", latest: "12:00" })).toMatch(
      /Oct 19, 10 AM to 12 PM$/,
    );
    expect(walkSlotLabel({ weekdays: [1, 4] })).toBe("Mon and Thu, any time");
  });

  it("has nothing to say when nothing a client reads changed", () => {
    const a = { day: "2026-10-19", earliest: "10:00", latest: "12:00" };
    expect(walkScheduleLine(a, { ...a })).toBeNull();
    expect(walkScheduleLine(a, { ...a, day: "2026-10-20" })).not.toBeNull();
  });

  it("a plan's schedule is its days and window, nothing else", () => {
    const a = { weekdays: [1, 3], earliest: "10:00:00", latest: "12:00:00" };
    expect(
      walkPlanScheduleChanged(a, { weekdays: [3, 1], earliest: "10:00", latest: "12:00" }),
    ).toBe(false);
    expect(walkPlanScheduleChanged(a, { ...a, weekdays: [1, 3, 5] })).toBe(true);
    expect(walkPlanScheduleChanged(a, { ...a, latest: "13:00" })).toBe(true);
  });
});

describe("the templates", () => {
  it("are registered", () => {
    expect(TEMPLATES["walk-not-done"]).toBeDefined();
    expect(TEMPLATES["walk-schedule-changed"]).toBeDefined();
  });

  it("a skipped walk says the dog and the reason; a missed one says the business will be in touch", async () => {
    const skipped = await render(
      React.createElement(TEMPLATES["walk-not-done"].component, {
        orgName: "Acme Walks",
        clientName: "Jane",
        kind: "skipped",
        dogs: "Bella",
        day: "Mon, Oct 19",
        reason: walkSkipReason("gate_locked"),
      }),
    );
    expect(skipped).toContain("We could not walk Bella today");
    expect(skipped).toContain("the gate was locked");
    const missed = await render(
      React.createElement(TEMPLATES["walk-not-done"].component, {
        orgName: "Acme Walks",
        clientName: "Jane",
        kind: "missed",
        dogs: "Bella",
        day: "Mon, Oct 19",
      }),
    );
    expect(missed).toContain("Mon, Oct 19");
    expect(missed.replace(/<!-- -->/g, "")).toContain("Acme Walks will be in touch.");
  });

  it("a schedule change shows each walk as was and now", async () => {
    const html = await render(
      React.createElement(TEMPLATES["walk-schedule-changed"].component, {
        orgName: "Acme Walks",
        changes: [{ before: "Mon, Oct 19, 10 AM to 12 PM", after: "Tue, Oct 20, 10 AM to 12 PM" }],
      }),
    );
    expect(html).toContain("Your walk schedule changed");
    expect(html).toContain("Mon, Oct 19, 10 AM to 12 PM");
    expect(html).toContain("Tue, Oct 20, 10 AM to 12 PM");
  });
});

describe("on my way", () => {
  const PROPS: Record<string, unknown>[] = [
    {},
    { orgName: "Acme Scoop", clientName: "Jane", techName: "Sam" },
    {
      orgName: "Acme Scoop",
      clientName: "Jane",
      techName: "Sam",
      eta: "between 10:15 AM and 10:45 AM",
      address: "412 Elm St",
      trackUrl: "https://example.com/track/abc",
    },
  ];

  it("is byte for byte what it was for every visit that is not a walk", async () => {
    for (const p of PROPS) {
      const now = await render(React.createElement(TEMPLATES["on-my-way"].component, p));
      const before = await render(React.createElement(onMyWayBefore.component, p));
      expect(now).toBe(before);
      expect((TEMPLATES["on-my-way"].subject as (d: any) => string)(p)).toBe(
        (onMyWayBefore.subject as (d: any) => string)(p),
      );
    }
  });

  it("says walker and walk for a walk, and asks about getting in", async () => {
    const html = await render(
      React.createElement(TEMPLATES["on-my-way"].component, {
        orgName: "Acme Walks",
        clientName: "Jane",
        walk: true,
      }),
    );
    expect(html).toContain("walker");
    expect(html).toContain("today&#x27;s walk");
    expect(html).not.toContain("dog out in the yard");
    expect((TEMPLATES["on-my-way"].subject as (d: any) => string)({ walk: true })).toBe(
      "Your walker is on the way",
    );
  });

  it("is told it is a walk only by the visit's service line", () => {
    const server = read("src/lib/on-my-way.server.ts");
    expect(server).toMatch(/services\(service_line\)/);
    expect(server).toMatch(
      /\.\.\.\(isDogWalk\(\(v as any\)\.services\) \? \{ walk: true \} : \{\}\)/,
    );
    expect(server).toMatch(/service_line === "dog_walking"/);
  });
});

// ── The senders ─────────────────────────────────────────────────────────────

describe("a skipped or missed walk", () => {
  it("emails the walk's client once per walk, behind its own switch", async () => {
    db.visits = [visit()];
    await notifyWalkNotDone({ visitId: "v1", kind: "skipped" });
    expect(db.sent).toHaveLength(1);
    expect(db.sent[0]).toMatchObject({
      organizationId: "org-1",
      clientId: "c1",
      templateName: "walk-not-done",
      notifyKey: "notify_email_walk_not_done",
      idempotencyKey: "walk-skipped-v1",
      oncePerKey: true,
      templateData: { kind: "skipped", dogs: "Bella", reason: walkSkipReason("gate_locked") },
    });
  });

  it("sends nothing for a cleanup", async () => {
    db.visits = [visit({ services: SCOOP })];
    await notifyWalkNotDone({ visitId: "v1", kind: "skipped" });
    expect(db.sent).toEqual([]);
  });

  it("emails each missed walk from the last few days, and nothing for a missed cleanup", async () => {
    db.visits = [
      visit({ id: "w1", status: "missed", scheduled_on: "2026-10-14" }),
      visit({ id: "w2", status: "missed", scheduled_on: "2026-10-01" }),
      visit({ id: "p1", status: "missed", scheduled_on: "2026-10-14", services: SCOOP }),
    ];
    const n = await notifyMissedWalks("org-1", "2026-10-15");
    expect(n).toBe(1);
    expect(db.sent.map((s) => s.idempotencyKey)).toEqual(["walk-missed-w1"]);
    expect(db.sent[0].oncePerKey).toBe(true);
    expect(db.sent[0].templateData.reason).toBeUndefined();
  });
});

describe("the office moved walks", () => {
  it("emails each client once for the whole move, with every walk that moved", async () => {
    db.visits = [
      visit({ id: "a", status: "scheduled", client_id: "c1", scheduled_on: "2026-10-19" }),
      visit({ id: "b", status: "scheduled", client_id: "c1", scheduled_on: "2026-10-21" }),
      visit({ id: "c", status: "scheduled", client_id: "c2", scheduled_on: "2026-10-19" }),
      visit({ id: "d", status: "scheduled", client_id: "c3", services: SCOOP }),
    ];
    const watch = await watchWalkSchedule(["a", "b", "c", "d"]);
    for (const v of db.visits) v.scheduled_on = "2026-10-22";
    await watch.finish(moveKey(["a", "b", "c", "d"], "2026-10-22"));
    expect(db.sent.map((s) => s.clientId).sort()).toEqual(["c1", "c2"]);
    const c1 = db.sent.find((s) => s.clientId === "c1");
    expect(c1).toMatchObject({
      templateName: "walk-schedule-changed",
      notifyKey: "notify_email_walk_schedule_change",
    });
    expect(c1.templateData.changes).toHaveLength(2);
    expect(c1.idempotencyKey).toMatch(/^walk-moved-c1-2026-10-22-/);
  });

  it("sends nothing when the move changed nothing", async () => {
    db.visits = [visit({ status: "scheduled" })];
    const watch = await watchWalkSchedule(["v1"]);
    await watch.finish("same");
    expect(db.sent).toEqual([]);
  });

  it("the key is the same for the same move and different for another", () => {
    expect(moveKey(["a", "b"], "2026-10-22")).toBe(moveKey(["b", "a"], "2026-10-22"));
    expect(moveKey(["a", "b"], "2026-10-22")).not.toBe(moveKey(["a", "b"], "2026-10-23"));
  });
});

describe("a walk plan changed", () => {
  const plan = (over: Record<string, unknown> = {}) => ({
    id: "s1",
    organization_id: "org-1",
    client_id: "c1",
    status: "active",
    weekdays: [2, 4],
    earliest_time: "10:00:00",
    latest_time: "12:00:00",
    services: WALK,
    properties: { visit_contact_email: null },
    ...over,
  });
  const before = { weekdays: [1, 3], earliest_time: "10:00:00", latest_time: "12:00:00" };

  it("emails the old and new days once", async () => {
    db.subscriptions = [plan()];
    await notifyWalkPlanChanged({ subscriptionId: "s1", before });
    expect(db.sent).toHaveLength(1);
    expect(db.sent[0].templateData.changes).toEqual([
      { before: "Mon and Wed, 10 AM to 12 PM", after: "Tue and Thu, 10 AM to 12 PM" },
    ]);
  });

  it("sends nothing for a cleanup plan, an ended plan, or a change that left the schedule alone", async () => {
    db.subscriptions = [plan({ services: SCOOP })];
    await notifyWalkPlanChanged({ subscriptionId: "s1", before });
    db.subscriptions = [plan({ status: "canceled" })];
    await notifyWalkPlanChanged({ subscriptionId: "s1", before });
    db.subscriptions = [plan({ weekdays: [1, 3] })];
    await notifyWalkPlanChanged({ subscriptionId: "s1", before });
    expect(db.sent).toEqual([]);
  });
});

// ── Where they are called from ──────────────────────────────────────────────

describe("the call sites", () => {
  it("a walker's skip tells the client after the skip is saved", () => {
    const src = read("src/lib/my-day.functions.ts");
    const skip = src.slice(
      src.indexOf("export const skipVisit"),
      src.indexOf("export const recordVisitPhoto"),
    );
    expect(skip.indexOf('rpc("skip_visit"')).toBeLessThan(skip.indexOf("notifyWalkNotDone"));
    expect(skip).toMatch(/notifyWalkNotDone\(\{ visitId: data\.visitId, kind: "skipped" \}\)/);
  });

  it("both office moves read the walks before the move and send after it", () => {
    const src = read("src/lib/visits.functions.ts");
    for (const [name, rpc] of [
      ["rescheduleVisitFromOffice", '"reschedule_visit"'],
      ["bulkRescheduleVisits", '"bulk_reschedule_visits"'],
    ]) {
      const body = src.slice(src.indexOf(`export const ${name}`));
      const end = body.indexOf("\nexport const ", 10);
      const fn = body.slice(0, end);
      expect(fn.indexOf("watchWalkSchedule("), name).toBeGreaterThan(0);
      expect(fn.indexOf("watchWalkSchedule("), name).toBeLessThan(fn.indexOf(rpc));
      expect(fn.indexOf("walks.finish("), name).toBeGreaterThan(fn.indexOf(rpc));
    }
  });

  it("a plan edit reads the old window and tells the client", () => {
    const src = read("src/lib/subscriptions.functions.ts");
    const fn = src.slice(src.indexOf("export const updateSubscription"));
    expect(fn).toMatch(/service_id, earliest_time, latest_time"/);
    expect(fn).toMatch(/notifyWalkPlanChanged\(\{/);
  });

  it("the nightly run sends missed walks after marking them missed", () => {
    const src = read("src/routes/api/public/hooks/nightly.ts");
    expect(src.indexOf('"admin_transition_missed_visits"')).toBeLessThan(
      src.indexOf("notifyMissedWalks(org.id, todayStr)"),
    );
  });

  it("the switches exist, are typed, and are drawn only for a walking business", () => {
    const enqueue = read("src/lib/email/enqueue.server.ts");
    expect(enqueue).toMatch(/"notify_email_walk_not_done"/);
    expect(enqueue).toMatch(/"notify_email_walk_schedule_change"/);
    const page = read("src/routes/_authenticated/settings.emails.tsx");
    expect(page).toMatch(/\.\.\.\(values\.runs_dog_walking \? WALK_ROWS : \[\]\)/);
    const sql = read("supabase/migrations/20261015220000_a-client-hears-when-a-walk-changes.sql");
    expect(sql).toMatch(/notify_email_walk_not_done boolean NOT NULL DEFAULT true/);
    expect(sql).toMatch(/notify_email_walk_schedule_change boolean NOT NULL DEFAULT true/);
  });
});
