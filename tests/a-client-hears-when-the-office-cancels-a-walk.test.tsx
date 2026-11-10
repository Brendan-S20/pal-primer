// A client hears when the office cancels a walk (#410 follow-up).
//
// The office cancels a dog walk from the visit drawer or the client page
// (one, or a selection at once). The walk's client gets one email per
// action, naming the dogs, the day and the window, and never the reason the
// office typed. Only a dog walk for today or later sends anything, so a
// pet-waste client's emails are what they were. The switch is on the
// business, on by default, and drawn only for a walking business.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as React from "react";
import { render } from "react-email";

// The fixtures are fixed walk days in October 2026, and the date formatters
// drop the year only when it is the CURRENT year, so against the real clock
// these assertions turn red on 2027-01-01 (found by running the suite under
// faketime for #843). Pin the clock for the whole file instead of making the
// days relative to today. Only Date is faked, so promises and timers run as
// normal.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T12:00:00-06:00"));
});
afterEach(() => {
  vi.useRealTimers();
});

const db = vi.hoisted(() => ({
  visits: [] as any[],
  organizations: [] as any[],
  sent: [] as any[],
}));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    const q: any = {
      select: () => q,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), q),
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

// The queue, with the one rule of enqueueAppEmail this email leans on: a
// switch the business turned off sends nothing (enqueue.server.ts, pinned
// below as source).
vi.mock("@/lib/email/enqueue.server", () => ({
  enqueueAppEmail: async (p: any) => {
    const org = db.organizations.find((o) => o.id === p.organizationId);
    if (org && p.notifyKey && org[p.notifyKey] === false) return { ok: false, reason: "org_toggle_off" };
    db.sent.push(p);
    return { ok: true };
  },
}));

const { notifyWalksCanceled } = await import("@/lib/walk-notify.server");
const { canceledWalkLabel, walkCanceledSubject } = await import("@/lib/walk-notify");
const { TEMPLATES } = await import("@/lib/email-templates/registry");

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

// Far from today either way, so the tests do not depend on the date.
const FUTURE = "2099-10-19";
const FUTURE_2 = "2099-10-21";
const PAST = "2001-10-19";

const WALK = { service_line: "dog_walking" };
const SCOOP = { service_line: "pet_waste" };

function visit(over: Record<string, unknown> = {}) {
  return {
    id: "v1",
    organization_id: "org-1",
    client_id: "c1",
    scheduled_on: FUTURE,
    status: "skipped",
    skip_reason_code: "other",
    subscription_id: "s1",
    services: WALK,
    subscriptions: { earliest_time: "10:00:00", latest_time: "12:00:00" },
    properties: { visit_contact_email: null, dogs: [{ name: "Bella", active: true }] },
    ...over,
  };
}

beforeEach(() => {
  db.visits = [];
  db.organizations = [{ id: "org-1", timezone: "America/Chicago", notify_email_walk_canceled: true }];
  db.sent = [];
});

describe("the words", () => {
  it("says the day, and the window only when the plan has one", () => {
    expect(canceledWalkLabel({ day: "2026-10-19", earliest: "10:00", latest: "12:00" })).toMatch(
      /Oct 19, 10 AM to 12 PM$/,
    );
    expect(canceledWalkLabel({ day: "2026-10-19" })).toMatch(/Oct 19$/);
    expect(canceledWalkLabel({ day: "2026-10-19" })).not.toMatch(/any time/);
  });

  it("one walk names its day; several say how many", () => {
    expect(walkCanceledSubject(1, "Mon, Oct 19")).toBe("Your walk on Mon, Oct 19 is canceled");
    expect(walkCanceledSubject(3, "Mon, Oct 19")).toBe("3 of your walks are canceled");
  });
});

describe("the template", () => {
  it("is registered, and its subject is the heading", () => {
    const t = TEMPLATES["walk-canceled"];
    expect(t).toBeDefined();
    expect((t.subject as (d: any) => string)({ day: "Mon, Oct 19", walks: ["x"] })).toBe(
      "Your walk on Mon, Oct 19 is canceled",
    );
  });

  it("names the dogs, the day and the window", async () => {
    const html = (
      await render(
        React.createElement(TEMPLATES["walk-canceled"].component, {
          orgName: "Acme Walks",
          clientName: "Jane",
          dogs: "Bella and Max",
          day: "Mon, Oct 19",
          walks: ["Mon, Oct 19, 10 AM to 12 PM"],
          count: 1,
        }),
      )
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("Your walk on Mon, Oct 19 is canceled");
    expect(html).toContain("Bella and Max");
    expect(html).toContain("Mon, Oct 19, 10 AM to 12 PM");
    expect(html).toContain("Acme Walks canceled the walk");
  });

  it("lists every walk of a bulk cancel and counts the rest", async () => {
    const html = (
      await render(
        React.createElement(TEMPLATES["walk-canceled"].component, {
          dogs: "Bella",
          day: "Mon, Oct 19",
          walks: ["Mon, Oct 19", "Wed, Oct 21"],
          count: 3,
        }),
      )
    ).replace(/<!-- -->/g, "");
    expect(html).toContain("3 of your walks are canceled");
    expect(html).toContain("Wed, Oct 21");
    expect(html).toContain("And one more.");
  });

  it("is a customer email in US spelling with no reason field", () => {
    const src = read("src/lib/email-templates/walk-canceled.tsx");
    expect(src).not.toMatch(/cancelled/);
    expect(src).not.toMatch(/reason\??:/);
  });
});

describe("the sender", () => {
  it("emails a canceled walk's client once, behind its own switch, without the reason", async () => {
    db.visits = [visit()];
    await notifyWalksCanceled({ visitIds: ["v1"], orgId: "org-1" });
    expect(db.sent).toHaveLength(1);
    expect(db.sent[0]).toMatchObject({
      organizationId: "org-1",
      clientId: "c1",
      templateName: "walk-canceled",
      notifyKey: "notify_email_walk_canceled",
      idempotencyKey: "walk-canceled-v1",
      oncePerKey: true,
      templateData: { dogs: "Bella", count: 1 },
    });
    expect(db.sent[0].templateData.walks[0]).toMatch(/Oct 19, (2099, )?10 AM to 12 PM$/);
    expect(JSON.stringify(db.sent[0].templateData)).not.toMatch(/reason/i);
  });

  it("sends nothing for a cleanup", async () => {
    db.visits = [visit({ services: SCOOP })];
    await notifyWalksCanceled({ visitIds: ["v1"] });
    expect(db.sent).toEqual([]);
  });

  it("sends nothing when the business turned the switch off", async () => {
    db.organizations[0].notify_email_walk_canceled = false;
    db.visits = [visit()];
    await notifyWalksCanceled({ visitIds: ["v1"] });
    expect(db.sent).toEqual([]);
  });

  it("sends nothing for a walk whose day has passed", async () => {
    db.visits = [visit({ scheduled_on: PAST })];
    await notifyWalksCanceled({ visitIds: ["v1"] });
    expect(db.sent).toEqual([]);
  });

  it("sends nothing for a walk that was not canceled", async () => {
    db.visits = [visit({ status: "scheduled" })];
    await notifyWalksCanceled({ visitIds: ["v1"] });
    expect(db.sent).toEqual([]);
  });

  it("reads only the caller's business when told which", async () => {
    db.visits = [visit({ organization_id: "org-2" })];
    await notifyWalksCanceled({ visitIds: ["v1"], orgId: "org-1" });
    expect(db.sent).toEqual([]);
  });

  it("a bulk cancel is one email per client, listing that client's walks", async () => {
    db.visits = [
      visit({ id: "a", client_id: "c1", scheduled_on: FUTURE_2 }),
      visit({ id: "b", client_id: "c1", scheduled_on: FUTURE }),
      visit({ id: "c", client_id: "c2" }),
      visit({ id: "d", client_id: "c3", services: SCOOP }),
      visit({ id: "e", client_id: "c1", scheduled_on: PAST }),
    ];
    await notifyWalksCanceled({ visitIds: ["a", "b", "c", "d", "e"] });
    expect(db.sent.map((s) => s.clientId).sort()).toEqual(["c1", "c2"]);
    const c1 = db.sent.find((s) => s.clientId === "c1");
    expect(c1.templateData.count).toBe(2);
    expect(c1.templateData.walks[0]).toMatch(/Oct 19/);
    expect(c1.templateData.walks[1]).toMatch(/Oct 21/);
    expect(c1.idempotencyKey).toMatch(/^walk-canceled-c1-/);
    expect(db.sent.find((s) => s.clientId === "c2").idempotencyKey).toBe("walk-canceled-c");
  });
});

describe("the call sites", () => {
  const fnBody = (src: string, name: string) => {
    const body = src.slice(src.indexOf(`export const ${name}`));
    const end = body.indexOf("\nexport const ", 10);
    return end === -1 ? body : body.slice(0, end);
  };

  it("an office cancel tells the walk's client after the cancel is saved", () => {
    const fn = fnBody(read("src/lib/visits.functions.ts"), "cancelVisitFromOffice");
    expect(fn).toMatch(/notifyClient: z\.boolean\(\)\.default\(true\)/);
    expect(fn.indexOf('"office_skip_visit"')).toBeGreaterThan(0);
    expect(fn.indexOf("notifyWalksCanceled(")).toBeGreaterThan(fn.indexOf('"office_skip_visit"'));
    expect(fn).toMatch(
      /if \(data\.notifyClient\) \{[\s\S]*?notifyWalksCanceled\(\{ visitIds: \[data\.visitId\], orgId: v\.organization_id \}\)/,
    );
    // The typed reason goes to the database and the activity log, not the email.
    const call = fn.slice(fn.indexOf("notifyWalksCanceled("), fn.indexOf("notifyWalksCanceled(") + 90);
    expect(call).not.toMatch(/reason/);
  });

  it("the client page's bulk cancel emails once for the set, and only for a walking business", () => {
    const tab = read("src/components/client-detail/VisitsTab.tsx");
    expect(tab).toMatch(/const runsWalks = useServiceLines\(\)\.lines\.includes\("dog_walking"\);/);
    expect(tab).toMatch(/notifyClient: !runsWalks,/);
    expect(tab).toMatch(/if \(runsWalks && canceled\.length > 0\) \{/);
    expect(tab).toMatch(/notifyWalksFn\(\{ data: \{ visitIds: canceled \} \}\)/);
  });

  it("the bulk notice asks for the cancel's own permission and stays in the caller's business", () => {
    const src = read("src/lib/walk-notify.functions.ts");
    expect(src).toMatch(
      /requirePermission\(\s*context\.supabase,\s*context\.userId,\s*"manage_client_billing",?\s*\)/,
    );
    expect(src).toMatch(/notifyWalksCanceled\(\{ visitIds: data\.visitIds, orgId: caller\.orgId \}\)/);
    expect(read("src/lib/visits.functions.ts")).toMatch(
      /requirePermission\(supabase, userId, "manage_client_billing"\)/,
    );
  });

  it("an org switch that is off stops the email in the queue", () => {
    const enqueue = read("src/lib/email/enqueue.server.ts");
    expect(enqueue).toMatch(/"notify_email_walk_canceled"/);
    expect(enqueue).toMatch(/\(org as any\)\[params\.notifyKey\] === false/);
  });
});

describe("the switch", () => {
  it("is a column, on by default, with a check that it exists", () => {
    const sql = read(
      "supabase/migrations/20261016100000_a-client-hears-when-the-office-cancels-a-walk.sql",
    );
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS notify_email_walk_canceled boolean NOT NULL DEFAULT true/,
    );
    expect(sql).toMatch(/COMMENT ON COLUMN public\.organizations\.notify_email_walk_canceled/);
    expect(sql).toMatch(/DO \$check\$[\s\S]*RAISE EXCEPTION[\s\S]*\$check\$;\s*$/);
    expect(sql).not.toMatch(/—/);
  });

  it("is typed", () => {
    const types = read("src/integrations/supabase/types.ts");
    expect(types.match(/notify_email_walk_canceled\??: boolean/g)).toHaveLength(3);
  });

  it("is read with the other walk switches and saved only when drawn", () => {
    const fns = read("src/lib/email-settings.functions.ts");
    expect(fns).toMatch(
      /"service_lines, notify_email_walk_not_done, notify_email_walk_schedule_change, notify_email_walk_canceled"/,
    );
    expect(fns).toMatch(/notify_email_walk_canceled: walk\?\.notify_email_walk_canceled !== false/);
    expect(fns).toMatch(/notify_email_walk_canceled: z\.boolean\(\)\.optional\(\)/);
  });

  it("is drawn only for a business that runs dog walking", () => {
    const page = read("src/routes/_authenticated/settings.emails.tsx");
    const walkRows = page.slice(page.indexOf("const WALK_ROWS"), page.indexOf("];", page.indexOf("const WALK_ROWS")));
    expect(walkRows).toMatch(/key: "notify_email_walk_canceled", label: "Walk canceled by the office"/);
    const rows = page.slice(page.indexOf("const ROWS"), page.indexOf("];", page.indexOf("const ROWS")));
    expect(rows).not.toMatch(/notify_email_walk_canceled/);
    expect(page).toMatch(
      /const rows = values\.runs_dog_walking \? \[\.\.\.base, \.\.\.WALK_ROWS\] : base;/,
    );
    expect(page).toMatch(/runs_dog_walking\s*\?\s*\{[\s\S]*?notify_email_walk_canceled,[\s\S]*?\}\s*:\s*rest/);
  });
});
