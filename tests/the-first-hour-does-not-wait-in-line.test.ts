/* eslint-disable @typescript-eslint/no-explicit-any -- PostgREST-shaped fakes */
// #786: the first hour felt slow enough to look broken. Measured on live:
// /auth ~7.9 s, Settings → Users 16.0 s, Settings → Client portal 13.9 s,
// skeletons for seconds on /dashboard, "Create my workspace" 4.3 s.
//
// None of those pages had one expensive request. Each had requests standing
// in line behind ones they did not depend on. These tests pin the four places
// that queued, by the order things START, not by a stopwatch -- a timing test
// passes on a fast machine and fails on a slow one, and an ordering test says
// what is actually wrong.
//
//   1. "Create my workspace" waited for the verification email to be sent
//      before going to /onboarding. The business already existed by then.
//   2. Sign-in asked "platform admin?" and only then "what role?": two round
//      trips in series for two reads that do not depend on each other.
//   3. The dashboard summary held four reads that do not use the time zone
//      behind the read that fetches the time zone.
//   4. Settings → Users and → Client portal asked for their data only after
//      the page's chunk had downloaded and mounted. Their route loaders now
//      start the same queries, under the same keys, as the navigation starts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── shared fakes ────────────────────────────────────────────────────────────

const state = vi.hoisted(() => ({
  events: [] as string[],
  tables: {} as Record<string, any>,
  calls: [] as string[],
}));

function delayed<T>(name: string, value: T, ms = 10): Promise<T> {
  state.events.push(`start:${name}`);
  return new Promise((resolve) =>
    setTimeout(() => {
      state.events.push(`end:${name}`);
      resolve(value);
    }, ms),
  );
}

/** A PostgREST-shaped builder that, like the real one, sends nothing until
 *  something calls `then`. */
function chain(table: string) {
  const q: any = {};
  for (const m of [
    "select",
    "eq",
    "in",
    "is",
    "gte",
    "lte",
    "order",
    "range",
    "limit",
    "single",
    "maybeSingle",
  ]) {
    q[m] = () => q;
  }
  q.then = (resolve: any, reject: any) =>
    delayed(table, { data: state.tables[table] ?? [], count: 3, error: null }).then(
      resolve,
      reject,
    );
  return q;
}
const db = {
  from: chain,
  rpc: (fn: string) =>
    delayed(`rpc:${fn}`, { data: state.tables[`rpc:${fn}`] ?? null, error: null }),
};

function overlaps(a: string, b: string) {
  const sa = state.events.indexOf(`start:${a}`);
  const sb = state.events.indexOf(`start:${b}`);
  expect(sa, `${a} never started`).toBeGreaterThanOrEqual(0);
  expect(sb, `${b} never started`).toBeGreaterThanOrEqual(0);
  expect(sa, `${a} waited for ${b}`).toBeLessThan(state.events.indexOf(`end:${b}`));
  expect(sb, `${b} waited for ${a}`).toBeLessThan(state.events.indexOf(`end:${a}`));
}

vi.mock("@tanstack/react-start", () => ({
  createServerOnlyFn: (fn: unknown) => fn,
  createServerFn: () => {
    const b: any = {
      middleware: () => b,
      inputValidator: () => b,
      handler: (h: any) => () => h({ context: { supabase: db, userId: "owner" } }),
    };
    return b;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org", role: "owner" }),
  requirePermission: async () => ({ orgId: "org", role: "owner" }),
}));
// The Settings server functions, as the route loaders see them.
vi.mock("@/lib/users.functions", () => ({
  listOrgUsers: () => (state.calls.push("listOrgUsers"), Promise.resolve({ users: [] })),
  listStaffAddresses: () => (
    state.calls.push("listStaffAddresses"),
    Promise.resolve({ staff: [] })
  ),
  listOrgInvites: () => (state.calls.push("listOrgInvites"), Promise.resolve({ invites: [] })),
}));
vi.mock("@/lib/org.functions", () => ({
  getOrgBranding: () => (state.calls.push("getOrgBranding"), Promise.resolve({})),
}));
vi.mock("@/lib/portal-change.functions", () => ({
  getPortalChangeSettings: () => (state.calls.push("getPortalChangeSettings"), Promise.resolve({})),
}));
vi.mock("@/lib/portal-booking.functions", () => ({
  getPortalBookingSettings: () => (
    state.calls.push("getPortalBookingSettings"),
    Promise.resolve({})
  ),
}));

import { QueryClient } from "@tanstack/react-query";
import { finishSignup, newSignupProgress } from "@/lib/finish-signup";
import { lookupLandingPath } from "@/lib/landing-path";
import { getDashboardSummary } from "@/lib/dashboard.functions";
import {
  CLIENT_PORTAL_PAGE_KEYS,
  USERS_PAGE_KEYS,
  prefetchClientPortalPage,
  prefetchUsersPage,
} from "@/lib/settings-prefetch";

beforeEach(() => {
  state.events = [];
  state.calls = [];
  state.tables = { organizations: { timezone: "UTC", disputes_in_analytics: false } };
});
afterEach(() => vi.restoreAllMocks());

const read = (rel: string) => readFileSync(path.join(import.meta.dirname, "..", rel), "utf8");

// ── 1. workspace create ─────────────────────────────────────────────────────

describe("Create my workspace does not wait for the verification email", () => {
  const form = {
    email: "owner@example-scoop.com",
    password: "correct horse",
    orgName: "Test Scooping",
    displayName: "Pat Owner",
    phone: "",
    smsConsent: false,
    promoCode: "",
  };
  const deps = (sendEmailVerification: () => Promise<unknown>) => ({
    registerAccount: vi.fn(async () => ({ ok: true })),
    signIn: vi.fn(async () => ({ error: null })),
    acceptPendingInvite: vi.fn(async () => null),
    bootstrapOrganization: vi.fn(async () => ({ promoStored: null })),
    recordSmsConsent: vi.fn(async () => ({ ok: true })),
    sendEmailVerification: vi.fn(sendEmailVerification),
    readAttribution: () => ({}),
    clearAttribution: vi.fn(),
    timezone: () => "America/Detroit",
    consentText: "I agree.",
    onPromoLost: vi.fn(),
  });

  it("lands on the workspace while the email is still being sent", async () => {
    // A send that never answers. Before #786 finishSignup never resolved.
    const d = deps(() => new Promise(() => {}));
    const outcome = await Promise.race([
      finishSignup(form, newSignupProgress(), d),
      new Promise((r) => setTimeout(() => r("still waiting on the email"), 50)),
    ]);
    expect(outcome).toBe("workspace");
    await Promise.resolve();
    expect(d.sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it("a failed send is still logged, and still never stops the signup", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = deps(async () => {
      throw new Error("mail provider down");
    });
    await expect(finishSignup(form, newSignupProgress(), d)).resolves.toBe("workspace");
    await new Promise((r) => setTimeout(r, 0));
    expect(logged).toHaveBeenCalledWith("verification email send failed", expect.any(Error));
  });
});

// ── 2. sign-in landing ──────────────────────────────────────────────────────

describe("sign-in asks both landing questions at once", () => {
  it("the platform-admin check and the role read overlap", async () => {
    state.tables.user_roles = { role: "tech" };
    await expect(lookupLandingPath(db as never, "u1")).resolves.toBe("/my-day");
    overlaps("rpc:is_platform_admin", "user_roles");
  });

  it("a platform admin still lands in the console, even if the role read failed", async () => {
    const failing = {
      rpc: () => Promise.resolve({ data: true }),
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: new Error("x") }) }),
        }),
      }),
    };
    await expect(lookupLandingPath(failing as never, "u1")).resolves.toBe("/platform");
  });

  it("a failed role read is still an error, not 'no role'", async () => {
    const failing = {
      rpc: () => Promise.resolve({ data: false }),
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: new Error("down") }),
          }),
        }),
      }),
    };
    await expect(lookupLandingPath(failing as never, "u1")).rejects.toThrow("down");
  });

  it.each([
    ["dispatcher", "/routes"],
    ["owner", "/dashboard"],
    ["office_manager", "/dashboard"],
  ])("%s lands on %s", async (role, to) => {
    state.tables.user_roles = { role };
    await expect(lookupLandingPath(db as never, "u1")).resolves.toBe(to);
  });

  it("auth.tsx uses the shared lookup rather than its own serial copy", () => {
    const src = read("src/routes/auth.tsx");
    expect(src).toContain('from "@/lib/landing-path"');
    expect(src).not.toMatch(
      /rpc\("is_platform_admin"[\s\S]{0,400}from\("user_roles"\)[\s\S]{0,200}"\/my-day"/,
    );
  });
});

// ── 3. dashboard summary ────────────────────────────────────────────────────

describe("the dashboard does not hold time-zone-free reads behind the time zone", () => {
  it.each(["clients", "staff", "qc_tickets", "invoices"])(
    "%s starts beside the organizations read",
    async (table) => {
      await getDashboardSummary();
      overlaps("organizations", table);
    },
  );

  it("today's visits still use the org's own day, so they wait for it", async () => {
    await getDashboardSummary();
    expect(state.events.indexOf("start:visits")).toBeGreaterThan(
      state.events.indexOf("end:organizations"),
    );
  });
});

// ── 4. Settings starts its reads with the navigation ────────────────────────

describe("Settings → Users and → Client portal start their reads from the route", () => {
  it("Users: the team and addresses for anybody, the invites for the owner only", async () => {
    const qc = new QueryClient();
    prefetchUsersPage(qc, "office_manager");
    await new Promise((r) => setTimeout(r, 0));
    expect(state.calls.sort()).toEqual(["listOrgUsers", "listStaffAddresses"]);
    expect(qc.getQueryData(USERS_PAGE_KEYS.users)).toEqual({ users: [] });

    state.calls = [];
    const qc2 = new QueryClient();
    prefetchUsersPage(qc2, "owner");
    await new Promise((r) => setTimeout(r, 0));
    expect(state.calls.sort()).toEqual(["listOrgInvites", "listOrgUsers", "listStaffAddresses"]);
  });

  it("Client portal: branding, change policy and booking", async () => {
    const qc = new QueryClient();
    prefetchClientPortalPage(qc);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.calls.sort()).toEqual([
      "getOrgBranding",
      "getPortalBookingSettings",
      "getPortalChangeSettings",
    ]);
    expect(qc.getQueryData(CLIENT_PORTAL_PAGE_KEYS.branding)).toEqual({});
  });

  it("a second hover inside the stale window does not ask again", async () => {
    const qc = new QueryClient();
    prefetchClientPortalPage(qc);
    await new Promise((r) => setTimeout(r, 0));
    prefetchClientPortalPage(qc);
    await new Promise((r) => setTimeout(r, 0));
    expect(state.calls).toHaveLength(3);
  });

  it("the loaders call them, and await nothing", () => {
    for (const [file, fn] of [
      ["src/routes/_authenticated/settings.users.tsx", "prefetchUsersPage"],
      ["src/routes/_authenticated/settings.client-portal.tsx", "prefetchClientPortalPage"],
    ] as const) {
      const src = read(file);
      const loader = src.match(/loader:\s*\(\{ context \}\)\s*=>\s*\{([\s\S]*?)\n\s*\},/);
      expect(loader, `${file} has no loader`).not.toBeNull();
      expect(loader![1]).toContain(`${fn}(context.queryClient`);
      expect(loader![1]).not.toMatch(/\bawait\b|\breturn\b/);
    }
  });

  // A prefetch under a key the page does not read is a request for nothing,
  // and then the page asks again. Both sides have to name the same key.
  it("the components read the very keys the loaders fill", () => {
    const cards: Array<[string, readonly string[]]> = [
      ["src/routes/_authenticated/settings.users.tsx", USERS_PAGE_KEYS.users],
      ["src/routes/_authenticated/settings.users.tsx", USERS_PAGE_KEYS.staffAddresses],
      ["src/routes/_authenticated/settings.users.tsx", USERS_PAGE_KEYS.invites],
      ["src/components/settings/ClientPortalCards.tsx", CLIENT_PORTAL_PAGE_KEYS.branding],
      ["src/components/settings/PortalChangePolicyCard.tsx", CLIENT_PORTAL_PAGE_KEYS.changePolicy],
      ["src/components/settings/PortalBookingCard.tsx", CLIENT_PORTAL_PAGE_KEYS.booking],
    ];
    for (const [file, key] of cards) {
      expect(read(file)).toContain(
        `useQuery({ queryKey: ${JSON.stringify(key).replace(/,/g, ", ")}`,
      );
    }
  });
});
