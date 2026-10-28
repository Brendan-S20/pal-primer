// A walk is not a yard in the portal (#410).
//
// Service history drew "Something missed? ... re-clean guarantee" under every
// completed visit, and its Report list offered "Missed spot" and "Wrong yard
// serviced". Those are pet waste words. On a walk the portal now offers no
// re-clean, offers walk issues instead of yard ones, and says a skipped walk
// in walk words. The server refuses a re-clean and the two yard options on a
// walk, so the rule holds for a request sent past the portal too. No new
// value goes into qc_tickets.category: a walk issue is stored as a category
// the table already takes, with the issue at the start of the message.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (h: (ctx: { data: unknown }) => unknown) =>
        async (opts: { data?: unknown } = {}) =>
          h({ data: validate(opts.data) }),
    };
    return b;
  },
}));

const db = vi.hoisted(() => ({
  visits: [] as any[],
  recent: [] as any[],
  rpcs: [] as Array<{ name: string; args: any }>,
  visitsError: false,
}));

vi.mock("@/lib/portal-auth.server", () => ({
  requirePortalSession: async () => ({ clientId: "c1", organizationId: "org-1", preview: false }),
}));

vi.mock("@/lib/notify-center.server", () => ({ notifyRoles: async () => {} }));

vi.mock("@/integrations/supabase/client.server", () => {
  const from = (table: string) => {
    const filters: Array<(r: any) => boolean> = [];
    const rows = () =>
      ((db as any)[table] ?? []).filter((r: any) => filters.every((f) => f(r)));
    const q: any = {
      select: () => q,
      eq: (col: string, v: unknown) => (filters.push((r) => r[col] === v), q),
      neq: (col: string, v: unknown) => (filters.push((r) => r[col] !== v), q),
      in: (col: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[col])), q),
      maybeSingle: async () =>
        table === "visits" && db.visitsError
          ? { data: null, error: { message: "down" } }
          : { data: rows()[0] ?? null, error: null },
      then: (res: (v: unknown) => unknown) =>
        Promise.resolve(
          table === "visits" && db.visitsError
            ? { data: null, error: { message: "down" } }
            : { data: rows(), error: null },
        ).then(res),
    };
    return q;
  };
  const rpc = async (name: string, args: any) => {
    db.rpcs.push({ name, args });
    if (name === "portal_list_recent_visits") return { data: db.recent, error: null };
    return { data: "ticket-1", error: null };
  };
  return { supabaseAdmin: { from, rpc } };
});

const { portalReportConcern, portalRequestReclean, portalListRecentVisits } = await import(
  "@/lib/portal.functions"
);
const {
  WALK_ISSUE_CODES,
  WALK_ISSUE_CATEGORY,
  WALK_ISSUE_LABELS,
  WALK_CONCERN_OPTIONS,
  walkConcernRow,
} = await import("@/lib/walk-concerns");
const { isInsideRecleanWindow, recleanRefusalMessage } = await import("@/lib/reclean");
const { VISIT_CONCERN_OPTIONS, VISIT_ISSUE_CODES, VISIT_ISSUE_CATEGORY, isYardVisit } =
  await import("@/lib/walk-concerns");
const { walkSkipReason } = await import("@/lib/walk-notify");

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const TOKEN = "11111111-1111-4111-8111-111111111111";
const WALK_VISIT = "22222222-2222-4222-8222-222222222222";
const YARD_VISIT = "33333333-3333-4333-8333-333333333333";
const OTHER_CLIENTS_VISIT = "44444444-4444-4444-8444-444444444444";
const SIT_VISIT = "55555555-5555-4555-8555-555555555555";
const GROOM_VISIT = "66666666-6666-4666-8666-666666666666";

beforeEach(() => {
  db.visits = [
    { id: WALK_VISIT, client_id: "c1", organization_id: "org-1", services: { service_line: "dog_walking" } },
    { id: YARD_VISIT, client_id: "c1", organization_id: "org-1", services: { service_line: "pet_waste" } },
    {
      id: SIT_VISIT,
      client_id: "c1",
      organization_id: "org-1",
      services: { service_line: "pet_sitting" },
    },
    {
      id: GROOM_VISIT,
      client_id: "c1",
      organization_id: "org-1",
      services: { service_line: "mobile_grooming" },
    },
    {
      id: OTHER_CLIENTS_VISIT,
      client_id: "c2",
      organization_id: "org-1",
      services: { service_line: "dog_walking" },
    },
  ];
  db.recent = [];
  db.rpcs = [];
  db.visitsError = false;
  vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
});

const rpcNames = () => db.rpcs.map((r) => r.name);

describe("the walk issues", () => {
  it("have copy in all four languages, for every code, with nothing empty", () => {
    for (const lng of ["en", "es", "ar", "zh"] as const) {
      expect(Object.keys(WALK_ISSUE_LABELS[lng]).sort(), lng).toEqual([...WALK_ISSUE_CODES].sort());
      for (const code of WALK_ISSUE_CODES) expect(WALK_ISSUE_LABELS[lng][code].trim(), `${lng}.${code}`).not.toBe("");
    }
  });

  it("offer no yard option, and the portal shows the English", () => {
    const labels = WALK_CONCERN_OPTIONS.map((o) => o.label).join(" | ");
    expect(labels).not.toMatch(/missed spot|yard|re-clean|scoop|cleanup/i);
    expect(WALK_CONCERN_OPTIONS.map((o) => o.label)).toEqual(
      WALK_ISSUE_CODES.map((c) => WALK_ISSUE_LABELS.en[c]),
    );
  });

  it("are stored as categories portal_report_concern already accepts", () => {
    const dir = join(ROOT, "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.startsWith("20260702162340_"));
    expect(file).toBeDefined();
    const sql = readFileSync(join(dir, file!), "utf8");
    const list = sql.match(/_category NOT IN \(([^)]+)\)/)![1];
    const accepted = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const code of WALK_ISSUE_CODES) expect(accepted, code).toContain(WALK_ISSUE_CATEGORY[code]);
  });

  it("put the issue at the start of the message, in words the office reads", () => {
    expect(walkConcernRow("walker_late", " 40 minutes late ")).toEqual({
      category: "other",
      message: "Walk: The walker was late or did not come. 40 minutes late",
    });
    expect(walkConcernRow("left_unsecured", "")).toEqual({
      category: "gate_left_open",
      message: "Walk: A gate, door or key was left unsecured.",
    });
  });
});

describe("the re-clean guarantee", () => {
  const now = new Date("2026-10-16T12:00:00Z");
  const done = { status: "completed", completed_at: "2026-10-16T10:00:00Z" };

  it("is never offered on a walk", () => {
    expect(isInsideRecleanWindow({ ...done, service_line: "dog_walking" }, 48, now)).toBe(false);
    expect(isInsideRecleanWindow({ ...done, service_line: "pet_waste" }, 48, now)).toBe(true);
    expect(isInsideRecleanWindow(done, 48, now)).toBe(true);
  });

  it("is refused for a walk by the server, before anything is written", async () => {
    await expect(
      portalRequestReclean({ data: { token: TOKEN, visitId: WALK_VISIT, message: "" } } as any),
    ).rejects.toThrow(recleanRefusalMessage("visit_is_a_walk"));
    expect(rpcNames()).not.toContain("portal_request_reclean");
  });

  it("is refused when the server cannot tell whether it is a walk", async () => {
    db.visitsError = true;
    await expect(
      portalRequestReclean({ data: { token: TOKEN, visitId: YARD_VISIT, message: "" } } as any),
    ).rejects.toThrow(/couldn't check that visit/);
    expect(rpcNames()).not.toContain("portal_request_reclean");
  });

  it("still goes through for a yard visit", async () => {
    await portalRequestReclean({ data: { token: TOKEN, visitId: YARD_VISIT, message: "" } } as any);
    expect(rpcNames()).toContain("portal_request_reclean");
  });

  it("says why in plain words", () => {
    expect(recleanRefusalMessage("visit_is_a_walk")).toBe(
      "A walk is not covered by the re-clean guarantee. You can still report a concern.",
    );
  });
});

describe("a concern on a walk", () => {
  const report = (visitId: string, category: string, message = "") =>
    portalReportConcern({ data: { token: TOKEN, visitId, category, message } } as any);

  it("refuses missed spot and wrong yard", async () => {
    await expect(report(WALK_VISIT, "missed_spot")).rejects.toThrow(/for a yard visit/);
    await expect(report(WALK_VISIT, "wrong_yard")).rejects.toThrow(/for a yard visit/);
    expect(rpcNames()).not.toContain("portal_report_concern");
  });

  it("stores a walk issue as an existing category with the issue in the message", async () => {
    await report(WALK_VISIT, "walker_late", "Came at 3");
    await report(WALK_VISIT, "left_unsecured");
    const calls = db.rpcs.filter((r) => r.name === "portal_report_concern").map((r) => r.args);
    expect(calls[0]).toMatchObject({
      _visit_id: WALK_VISIT,
      _category: "other",
      _message: "Walk: The walker was late or did not come. Came at 3",
    });
    expect(calls[1]).toMatchObject({ _category: "gate_left_open" });
  });

  it("leaves a yard visit's concern as it was", async () => {
    await report(YARD_VISIT, "missed_spot", "By the shed");
    const call = db.rpcs.find((r) => r.name === "portal_report_concern")!.args;
    expect(call).toMatchObject({ _category: "missed_spot", _message: "By the shed" });
  });

  it("refuses a code the server does not know", async () => {
    await expect(report(WALK_VISIT, "lost_dog")).rejects.toThrow();
  });
});

describe("service history", () => {
  it("marks each of the client's own visits with its service line", async () => {
    db.recent = [
      { visit_id: WALK_VISIT, status: "completed" },
      { visit_id: YARD_VISIT, status: "completed" },
      { visit_id: OTHER_CLIENTS_VISIT, status: "completed" },
    ];
    const rows = await portalListRecentVisits({ data: { token: TOKEN } } as any);
    expect(rows.map((r: any) => r.service_line)).toEqual(["dog_walking", "pet_waste", null]);
  });

  it("draws walk issues, walk words and no re-clean on a walk", () => {
    const ui = read("src/lib/portal-ui.tsx");
    expect(ui).toMatch(
      /isWalkLine\(r\.service_line\)\s+\? WALK_CONCERN_OPTIONS\s+: yard\s+\? CONCERN_OPTIONS\s+: VISIT_CONCERN_OPTIONS/,
    );
    // Only a yard visit (pet waste, #560) is offered the re-clean guarantee.
    expect(ui).toMatch(/const yard = isYardVisit\(r\.service_line, petWaste\)/);
    expect(ui).toMatch(/\{reclean &&\s+yard &&/);
    expect(ui).toMatch(
      /isWalkLine\(r\.service_line\) && r\.skip_reason_code !== "customer_requested"\s+\? walkSkipReason\(r\.skip_reason_code\)/,
    );
  });

  it("says a blocked walk in walk words, not yard words", () => {
    expect(walkSkipReason("access_blocked")).toBe("The walker could not get in.");
    expect(walkSkipReason("access_blocked")).not.toMatch(/yard/i);
  });
});

// #560: a sit, a groom or a lesson is not a yard either.
describe("a visit that is not a walk and not a yard", () => {
  const report = (visitId: string, category: string, message = "") =>
    portalReportConcern({ data: { token: TOKEN, visitId, category, message } } as any);

  it("is a yard visit only when its line is pet waste, or unknown in a pet-waste business", () => {
    expect(isYardVisit("pet_waste", false)).toBe(true);
    expect(isYardVisit("pet_sitting", true)).toBe(false);
    expect(isYardVisit("mobile_grooming", true)).toBe(false);
    expect(isYardVisit("training", true)).toBe(false);
    expect(isYardVisit(null, true)).toBe(true);
    expect(isYardVisit(null, false)).toBe(false);
  });

  it("offers visit issues with no yard word in them", () => {
    const labels = VISIT_CONCERN_OPTIONS.map((o) => o.label).join(" | ");
    expect(labels).not.toMatch(/missed spot|yard|re-clean|scoop|cleanup|walk/i);
  });

  it("stores visit issues as categories portal_report_concern already accepts", () => {
    const dir = join(ROOT, "supabase/migrations");
    const file = readdirSync(dir).find((f) => f.startsWith("20260702162340_"));
    const sql = readFileSync(join(dir, file!), "utf8");
    const list = sql.match(/_category NOT IN \(([^)]+)\)/)![1];
    const accepted = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    for (const code of VISIT_ISSUE_CODES)
      expect(accepted, code).toContain(VISIT_ISSUE_CATEGORY[code]);
  });

  it("refuses missed spot and wrong yard on a sit and a groom", async () => {
    await expect(report(SIT_VISIT, "missed_spot")).rejects.toThrow(/fits the visit/);
    await expect(report(GROOM_VISIT, "wrong_yard")).rejects.toThrow(/fits the visit/);
    expect(rpcNames()).not.toContain("portal_report_concern");
  });

  it("stores a visit issue with the issue at the start of the message", async () => {
    await report(SIT_VISIT, "home_unsecured", "Back door");
    const call = db.rpcs.find((r) => r.name === "portal_report_concern")!.args;
    expect(call).toMatchObject({
      _category: "gate_left_open",
      _message: "Visit: A door, gate or key was left unsecured. Back door",
    });
  });

  it("is never inside the re-clean window, and the server refuses one", async () => {
    const done = { status: "completed", completed_at: "2026-10-16T10:00:00Z" };
    const now = new Date("2026-10-16T12:00:00Z");
    for (const line of ["pet_sitting", "mobile_grooming", "training"])
      expect(isInsideRecleanWindow({ ...done, service_line: line }, 48, now), line).toBe(false);
    await expect(
      portalRequestReclean({ data: { token: TOKEN, visitId: GROOM_VISIT, message: "" } } as any),
    ).rejects.toThrow(recleanRefusalMessage("visit_is_not_pet_waste"));
    expect(rpcNames()).not.toContain("portal_request_reclean");
  });
});
