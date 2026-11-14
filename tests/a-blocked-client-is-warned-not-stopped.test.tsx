// @vitest-environment happy-dom
//
// #851 follow-up. Brendan, 2026-11-10 3:23 PM ET: "No, provide a warning as
// to why they were blocked." BLOCK (the owner's vaccine Start rule, #729)
// never stops a Complete; every Complete button explains it first.
//
// HoundStack Product's acceptance list, one describe each:
//
//   1. Complete on a never-started groom for a blocked client shows a warning
//      BEFORE anything is saved, naming the reason and who set it and when.
//   2. Continue completes exactly as today. Cancel changes nothing.
//   3. The completion records that the warning was shown and acknowledged,
//      who acknowledged it, and when.
//   4. Every path that completes a visit warns: My Day (which is also the iOS
//      and Android apps: they are this web code in Capacitor), the visit
//      drawer, the board, the client's Visits tab. No block, no warning.
//   5. A block with no reason reads "This client is blocked (no reason
//      given)". It never says nothing.
//   6. No change to Start or to the 7-day replay window.
//
// The real-database half (complete_visit and a status write both succeed on
// a blocked never-started groom; the timeline row lands) is
// tests/integration/a-blocked-client-can-still-be-completed.db.test.ts.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROOT = join(__dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const VISIT = "11111111-1111-4111-8111-111111111111";

const h = vi.hoisted(() => ({
  warning: vi.fn(async (_a: { data: { visitId: string } }): Promise<unknown> => null),
  rpc: vi.fn(async (_fn: string, _args?: unknown) => ({ data: null as unknown, error: null })),
  activity: vi.fn(async (_db: unknown, _entry: Record<string, unknown>) => {}),
  rows: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-start", () => ({
  useServerFn: (f: unknown) => f,
  createServerFn: () => {
    let validate: (d: unknown) => unknown = (d) => d;
    const b: any = {
      middleware: () => b,
      inputValidator: (v: (d: unknown) => unknown) => ((validate = v), b),
      handler:
        (fn: (a: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: stub(), userId: "user-1" } }),
    };
    return b;
  },
}));
vi.mock("@tanstack/react-start/server", () => ({ getRequest: () => null }));
vi.mock("@/lib/completion-block.functions", () => ({ getCompletionBlockWarning: h.warning }));
vi.mock("@/hooks/useOrgToday", () => ({ useOrgTimezone: () => "America/Detroit" }));
vi.mock("@/lib/i18n", () => ({ useIntlLocale: () => i18next.language }));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
  requirePermission: async () => ({ orgId: "org-1", role: "owner" }),
}));
vi.mock("@/lib/field-notify.server", () => ({
  startRouteWatch: async () => ({ finish: async () => {} }),
  afterStopResolved: async () => {},
}));
vi.mock("@/lib/push-liveactivity.server", () => ({
  watchRouteLiveActivities: async () => async () => {},
}));
vi.mock("@/lib/activity.server", () => ({ logActivity: h.activity }));
vi.mock("@/lib/training-portal.server", () => ({ afterLessonSessionChange: async () => {} }));

/** A Supabase client that answers by table, and records rpc calls. */
function stub() {
  return {
    from(table: string) {
      const q: any = {};
      for (const m of ["select", "eq", "in", "not", "order", "limit", "is"]) q[m] = () => q;
      const row = () => h.rows[table] ?? null;
      q.single = async () => ({ data: row(), error: null });
      q.maybeSingle = async () => ({ data: row(), error: null });
      q.insert = async () => ({ error: null });
      q.then = (res: any, rej: any) => Promise.resolve({ data: [], error: null }).then(res, rej);
      return q;
    },
    rpc: h.rpc,
  };
}

const BLOCKED = {
  missing: [
    { dog_id: "d1", dog_name: "Biscuit", vaccine: "rabies" },
    { dog_id: "d1", dog_name: "Biscuit", vaccine: "bordetella" },
    { dog_id: "d2", dog_name: "Luna", vaccine: "rabies" },
  ],
  setAt: "2026-11-08T15:00:00.000Z",
  setBy: "Olive Owner",
};

beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    resources: { en: { translation: en }, es: { translation: es } },
    interpolation: { escapeValue: false },
  });
});

const { useCompletionBlockWarning } = await import("@/components/CompletionBlockWarning");
const { completeFromOffice } = await import("@/components/OfficeCompleteOverride");
const lib = await import("@/lib/completion-block");
const { completionBlockWarning } = await import("@/lib/completion-block.server");
const { completeVisitFromOffice } = await import("@/lib/visits.functions");
const { completeVisit } = await import("@/lib/my-day.functions");

// ── a harness: the office composition, exactly as the three office buttons use it

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let api: ReturnType<typeof useCompletionBlockWarning> | null = null;

function Harness() {
  api = useCompletionBlockWarning();
  return api.dialog;
}

async function mount() {
  host = document.createElement("div");
  document.body.appendChild(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root = createRoot(host!);
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness)));
  });
}
const dialogText = () => document.querySelector('[role="alertdialog"]')?.textContent ?? "";
async function settle() {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
}
async function press(label: string) {
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent === label);
  if (!b) throw new Error(`no button "${label}" in: ${document.body.textContent}`);
  await act(async () => b.click());
  await settle();
}

beforeEach(async () => {
  h.warning.mockReset();
  h.warning.mockImplementation(async () => null);
  h.rpc.mockReset();
  h.rpc.mockImplementation(async () => ({ data: null, error: null }));
  h.activity.mockClear();
  h.rows = {};
  await i18next.changeLanguage("en");
  await mount();
});
afterEach(async () => {
  await act(async () => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

/** One office Complete, the way VisitDetailDrawer / routes / VisitsTab run it. */
function officeComplete(save: (overrideReason?: string, ack?: boolean) => void) {
  return completeFromOffice(
    async (overrideReason, ack) => (save(overrideReason, ack), { ok: true as const }),
    async () => null,
    () => api!.check(VISIT),
  );
}

describe("1. the warning comes before anything is saved, and says why, who and when", () => {
  it("names each pet's missing vaccines, the person who set BLOCK, and the day", async () => {
    h.warning.mockImplementation(async () => BLOCKED);
    const save = vi.fn();
    const done = officeComplete(save);
    await settle();
    expect(h.warning).toHaveBeenCalledWith({ data: { visitId: VISIT } });
    expect(save).not.toHaveBeenCalled();
    const text = dialogText();
    expect(text).toContain("This client is blocked");
    expect(text).toContain("Blocked: Biscuit: rabies, bordetella; Luna: rabies");
    expect(text).toMatch(/Set by Olive Owner on .*Nov.*8/);
    await press("Cancel");
    await expect(done).resolves.toBe(false);
  });

  it("a tech, who cannot read the trail, is told it was the owner", async () => {
    h.warning.mockImplementation(async () => ({ ...BLOCKED, setBy: null }));
    const done = officeComplete(vi.fn());
    await settle();
    expect(dialogText()).toMatch(/Set by the owner on/);
    await press("Cancel");
    await done;
  });

  it("speaks the tech's language: My Day is a tech screen", async () => {
    await i18next.changeLanguage("es");
    h.warning.mockImplementation(async () => BLOCKED);
    const done = officeComplete(vi.fn());
    await settle();
    expect(dialogText()).toContain("Este cliente está bloqueado");
    expect(dialogText()).toContain("Bloqueado: Biscuit: rabies, bordetella; Luna: rabies");
    await press("Cancelar");
    await done;
  });
});

describe("2. Continue completes as today; Cancel changes nothing", () => {
  it("Continue saves once, and says the warning was acknowledged", async () => {
    h.warning.mockImplementation(async () => BLOCKED);
    const save = vi.fn();
    const done = officeComplete(save);
    await settle();
    await press("Complete anyway");
    await expect(done).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(undefined, true);
  });

  it("Cancel saves nothing", async () => {
    h.warning.mockImplementation(async () => BLOCKED);
    const save = vi.fn();
    const done = officeComplete(save);
    await settle();
    await press("Cancel");
    await expect(done).resolves.toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("Continue still goes through the photo-or-checklist question, carrying the acknowledgement", async () => {
    h.warning.mockImplementation(async () => BLOCKED);
    const seen: Array<[string | undefined, boolean | undefined]> = [];
    const done = completeFromOffice(
      async (why, ack) => {
        seen.push([why, ack]);
        return seen.length === 1
          ? { ok: false as const, needsOverride: "no photo" }
          : { ok: true as const };
      },
      async () => "Done by phone",
      () => api!.check(VISIT),
    );
    await settle();
    await press("Complete anyway");
    await expect(done).resolves.toBe(true);
    expect(seen).toEqual([
      [undefined, true],
      ["Done by phone", true],
    ]);
  });

  it("the server never refuses because of the block: office_complete_visit is called as before", async () => {
    h.rows = {
      visits: {
        id: VISIT,
        organization_id: "org-1",
        client_id: "client-1",
        property_id: "prop-1",
        scheduled_on: "2000-01-01",
        status: "scheduled",
      },
      organizations: {
        vaccine_start_rule: "block",
        vaccine_start_rule_set_at: BLOCKED.setAt,
        timezone: "America/Detroit",
      },
    };
    h.rpc.mockImplementation(async (fn: string) => ({
      data: fn === "visit_missing_vaccines" ? BLOCKED.missing : null,
      error: null,
    }));
    const r = await (completeVisitFromOffice as any)({ data: { visitId: VISIT } });
    expect(r).toEqual({ ok: true });
    expect(h.rpc).toHaveBeenCalledWith("office_complete_visit", { _visit_id: VISIT });
  });
});

describe("3. the completion records the block, who, when, and whether it was acknowledged", () => {
  const blockedRows = () => {
    h.rows = {
      visits: {
        id: VISIT,
        organization_id: "org-1",
        client_id: "client-1",
        property_id: "prop-1",
        scheduled_on: "2000-01-01",
        status: "scheduled",
      },
      organizations: {
        vaccine_start_rule: "block",
        vaccine_start_rule_set_at: BLOCKED.setAt,
        timezone: "America/Detroit",
      },
      org_vaccine_policy_changes: { changed_by: "owner-1", changed_at: BLOCKED.setAt },
      staff: { display_name: "Olive Owner" },
    };
    h.rpc.mockImplementation(async (fn: string) => ({
      data: fn === "visit_missing_vaccines" ? BLOCKED.missing : null,
      error: null,
    }));
  };

  it("office Complete: the visit.completed entry carries blocked_completion", async () => {
    blockedRows();
    const before = Date.now();
    await (completeVisitFromOffice as any)({ data: { visitId: VISIT, blockAcknowledged: true } });
    const entry = h.activity.mock.calls.at(-1)![1] as any;
    expect(entry.kind).toBe("visit.completed");
    expect(entry.summary).toMatch(/despite the block, after the warning/);
    expect(entry.summary).toContain("Blocked: Biscuit: rabies, bordetella; Luna: rabies");
    const meta = entry.meta.blocked_completion;
    expect(meta).toMatchObject({
      reason: "Biscuit: rabies, bordetella; Luna: rabies",
      rule_set_at: BLOCKED.setAt,
      rule_set_by: "Olive Owner",
      warning_acknowledged: true,
      completed_by: "user-1",
    });
    expect(meta.missing).toHaveLength(3);
    expect(Date.parse(meta.completed_at)).toBeGreaterThanOrEqual(before);
  });

  it("a completion that never showed the warning is still recorded, as not acknowledged", async () => {
    blockedRows();
    await (completeVisitFromOffice as any)({ data: { visitId: VISIT } });
    const entry = h.activity.mock.calls.at(-1)![1] as any;
    expect(entry.summary).toMatch(/no warning was shown/);
    expect(entry.meta.blocked_completion.warning_acknowledged).toBe(false);
  });

  it("the tech's Complete (My Day, the apps, a queued replay) records it too", async () => {
    blockedRows();
    await (completeVisit as any)({ data: { visitId: VISIT, blockAcknowledged: true } }).catch(
      () => {},
    );
    expect(h.rpc).toHaveBeenCalledWith(
      "complete_visit",
      expect.objectContaining({ _visit_id: VISIT }),
    );
    const entry = h.activity.mock.calls.find(
      (c) => (c[1] as any).kind === "visit.completed",
    )![1] as any;
    expect(entry.meta.blocked_completion).toMatchObject({
      warning_acknowledged: true,
      completed_by: "user-1",
      reason: "Biscuit: rabies, bordetella; Luna: rabies",
    });
  });

  it("a queued completion carries the acknowledgement through the replay", () => {
    expect(read("src/lib/offline/queue.ts")).toMatch(/blockAcknowledged\?: boolean/);
    expect(read("src/lib/offline/sync.ts")).toMatch(/blockAcknowledged: action\.blockAcknowledged/);
    expect(read("src/lib/offline/useOfflineVisitActions.ts")).toMatch(
      /blockAcknowledged\?: boolean/,
    );
  });

  it("no block, no blocked_completion: the timeline reads exactly as before", async () => {
    h.rows = {
      visits: {
        id: VISIT,
        organization_id: "org-1",
        client_id: "client-1",
        property_id: "prop-1",
        scheduled_on: "2000-01-01",
        status: "scheduled",
      },
      organizations: { vaccine_start_rule: "warn", timezone: "America/Detroit" },
    };
    await (completeVisitFromOffice as any)({ data: { visitId: VISIT } });
    const entry = h.activity.mock.calls.at(-1)![1] as any;
    expect(entry.summary).toBe("Marked the visit on 2000-01-01 completed from the office");
    expect(entry.meta).toBeUndefined();
  });
});

describe("4. every Complete button warns, and an unblocked client sees nothing", () => {
  it("no block: no dialog, and the Complete goes straight through", async () => {
    const save = vi.fn();
    await expect(officeComplete(save)).resolves.toBe(true);
    expect(dialogText()).toBe("");
    expect(save).toHaveBeenCalledWith(undefined, undefined);
  });

  it("a lookup that fails never stops a Complete", async () => {
    h.warning.mockImplementation(async () => {
      throw new Error("offline");
    });
    const save = vi.fn();
    await expect(officeComplete(save)).resolves.toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("the server reads warn, other lines and a failed lookup as not blocked", async () => {
    h.rows = {
      visits: { organization_id: "org-1" },
      organizations: { vaccine_start_rule: "warn" },
    };
    expect(await completionBlockWarning(stub() as any, VISIT)).toBeNull();
    h.rows.organizations = { vaccine_start_rule: "block" };
    h.rpc.mockImplementation(async () => ({ data: [], error: null })); // a walk: nothing missing
    expect(await completionBlockWarning(stub() as any, VISIT)).toBeNull();
    h.rpc.mockImplementation(async () => ({ data: null, error: { message: "boom" } as any }));
    expect(await completionBlockWarning(stub() as any, VISIT)).toBeNull();
  });

  // Every file that completes a visit from a button. The replay plumbing
  // (useSyncCallers, useOfflineVisitActions) sends what My Day decided.
  const BUTTONS = [
    "src/routes/_authenticated/my-day.tsx",
    "src/components/VisitDetailDrawer.tsx",
    "src/routes/_authenticated/routes.tsx",
    "src/components/client-detail/VisitsTab.tsx",
  ];
  const PLUMBING = ["src/hooks/useSyncCallers.ts", "src/lib/offline/useOfflineVisitActions.ts"];

  it("no file completes a visit without the warning (a ratchet: a new Complete button must add it)", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
        const p = `${dir}/${e.name}`;
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    walk("src");
    // Code, not comments: router.tsx describes actions.complete() in prose.
    const code = (f: string) => read(f).replace(/^\s*(\/\/|\*).*$/gm, "");
    const completers = files.filter((f) =>
      /useServerFn\((completeVisitFromOffice|completeVisit)\)|actions\.complete\(/.test(code(f)),
    );
    expect(completers.sort()).toEqual([...BUTTONS, ...PLUMBING].sort());
  });

  it.each(BUTTONS.slice(1))("%s asks before it saves and renders the dialog", (f) => {
    const src = read(f);
    expect(src).toMatch(/const completionBlock = useCompletionBlockWarning\(\)/);
    expect(src).toMatch(/\(\) => completionBlock\.check\(/);
    expect(src).toMatch(/blockAcknowledged/);
    expect(src).toMatch(/\{completionBlock\.dialog\}/);
  });

  it("My Day asks before the walk report, the care log or the completion is sent", () => {
    const src = read("src/routes/_authenticated/my-day.tsx");
    const fn = src.slice(src.indexOf("const complete = useMutation({"));
    const ask = fn.indexOf("await completionBlock.check(visit.id)");
    expect(ask).toBeGreaterThan(-1);
    expect(ask).toBeLessThan(fn.indexOf("walkReport.send()"));
    expect(ask).toBeLessThan(fn.indexOf("actions.complete("));
    expect(fn.slice(0, fn.indexOf("onError"))).toMatch(/if \(block === "cancelled"\) return null;/);
    expect(fn).toMatch(/onSuccess: \(r\) => \{\s*if \(!r\) return;/);
    // Prefetched, so a groom in a dead zone still shows it from cache.
    expect(src).toMatch(/usePrefetchCompletionBlock\(visit\.id, isGroom/);
    expect(src).toMatch(/\{isGroom && completionBlock\.dialog\}/);
  });
});

describe("5. a block with no reason still says something", () => {
  it("reads 'This client is blocked (no reason given)'", async () => {
    h.warning.mockImplementation(async () => ({
      missing: [{ dog_id: "d1", dog_name: "", vaccine: "" }],
      setAt: null,
      setBy: null,
    }));
    const done = officeComplete(vi.fn());
    await settle();
    expect(dialogText()).toContain("This client is blocked (no reason given)");
    expect(dialogText()).toContain("Set by the owner.");
    await press("Cancel");
    await done;
  });

  it("and the timeline says the same", () => {
    const w = { missing: [], setAt: null, setBy: null };
    expect(lib.completionBlockReason(w)).toBe("");
    expect(lib.blockedCompletionSummary(w, true)).toContain(lib.COMPLETION_BLOCK_NO_REASON);
    expect(
      lib.blockedCompletionMeta(w, { acknowledged: true, completedBy: "u", completedAt: "t" })
        .reason,
    ).toBeNull();
    expect(en.completionBlock.noReason).toBe(lib.COMPLETION_BLOCK_NO_REASON);
  });
});

describe("6. Start and the 7-day replay window are unchanged", () => {
  it("no migration in this change, and the last word on start_visit_as and complete_visit is still #851's", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).sort();
    const lastDefining = (fn: string) =>
      files
        .filter((f) =>
          new RegExp(`FUNCTION public\\.${fn}\\(`).test(read(`supabase/migrations/${f}`)),
        )
        .at(-1);
    // #851's start_visit / guard, untouched.
    expect(lastDefining("start_visit")).toBe(
      "20261110140000_a-blocked-start-holds-against-a-direct-write.sql",
    );
    expect(lastDefining("visits_vaccine_start_guard")).toBe(
      "20261110140000_a-blocked-start-holds-against-a-direct-write.sql",
    );
    // start_visit_as keeps its 7-day bound.
    const startAs = read(`supabase/migrations/${lastDefining("start_visit_as")}`);
    expect(startAs).toMatch(/_started_at >= now\(\) - interval '7 days'/);
    // Nothing added refuses a completion because of the vaccine rule.
    const complete = read(`supabase/migrations/${lastDefining("complete_visit")}`);
    expect(complete).not.toMatch(/VACCINE_START_BLOCKED|vaccine_start_rule/);
  });

  it("My Day's Start is not touched by the warning", () => {
    const src = read("src/routes/_authenticated/my-day.tsx");
    const start = src.slice(
      src.indexOf("const start = useMutation({"),
      src.indexOf("const completeToast"),
    );
    expect(start).not.toMatch(/completionBlock/);
    expect(start).toMatch(/isVaccineStartBlocked\(e\)/);
  });
});
