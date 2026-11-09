// #682, the behaviour half. tests/a-role-gate-that-redirected-over-a-load
// pins the SHAPE of the fix by reading the source; this runs RoleGuard itself
// against the router states a gated hit passes through and checks what it
// does in each.
//
// The fault: every gated hit (dispatcher or office manager on
// /settings/billing, dispatcher on /invoices, tech on either) logged
//   TypeError: Cannot read properties of undefined (reading '_nonReactive')
//   at async Promise.all (index 2)
// The "index 2" is loadMatches' per-match promise for the third match, the
// gated page's own layout or page. A preload was still running on it when
// RoleGuard navigated away, the navigation dropped the match, and the preload
// finished by reading `router.getMatch(id)._nonReactive` on nothing.
//
// What RoleGuard must therefore do, and what this checks:
//   - nothing while a navigation is in flight, even though `location` already
//     names the gated page (the router sets it when a navigation STARTS);
//   - nothing while the role is still unknown;
//   - once the router is idle on a gated page, exactly one redirect (replace,
//     so Back does not return to the refusal) and one toast, to the role's home;
//   - nothing for a role that may open the page.
//
// No DOM here (vitest runs in node), so the component is called as a function
// with its hooks stubbed and useEffect run inline. RoleGuard's own decision
// and its own selector are what run, against router states built the way
// TanStack Router builds them.

import { beforeEach, describe, expect, it, vi } from "vitest";

type RouterState = {
  status: "idle" | "pending";
  location: { pathname: string };
  resolvedLocation?: { pathname: string };
};

const h = vi.hoisted(() => ({
  router: null as unknown as RouterState,
  role: null as string | null,
  loading: false,
  accessTurnedOff: false,
  navigations: [] as Array<{ to: string; replace?: boolean }>,
  toasts: [] as string[],
}));

vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useEffect: (fn: () => void) => fn(),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => (opts: { to: string; replace?: boolean }) => void h.navigations.push(opts),
  useRouterState: ({ select }: { select: (s: RouterState) => unknown }) => select(h.router),
}));
vi.mock("sonner", () => ({ toast: { error: (m: string) => void h.toasts.push(m) } }));
vi.mock("@/hooks/useMyRole", async (orig) => ({
  ...(await orig<typeof import("@/hooks/useMyRole")>()),
  useMyRole: () => ({
    role: h.role,
    orgId: "org-1",
    loading: h.loading,
    accessTurnedOff: h.accessTurnedOff,
  }),
}));
vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));

import { RoleGuard } from "@/components/RoleGuard";

/** A navigation that has started and not finished: TanStack sets `location`
 *  to the target at once and `resolvedLocation` only when it settles. */
const inFlight = (from: string, to: string): RouterState => ({
  status: "pending",
  location: { pathname: to },
  resolvedLocation: { pathname: from },
});
const settledOn = (path: string): RouterState => ({
  status: "idle",
  location: { pathname: path },
  resolvedLocation: { pathname: path },
});

beforeEach(() => {
  h.navigations = [];
  h.toasts = [];
  h.role = null;
  h.loading = false;
  h.accessTurnedOff = false;
});

describe("RoleGuard on a page the role may not open (#682)", () => {
  it("does nothing while the navigation onto the gated page is still loading", () => {
    h.role = "dispatcher";
    h.router = inFlight("/dashboard", "/invoices");
    RoleGuard();
    expect(h.navigations).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it("does nothing on a first load that has not resolved anywhere yet", () => {
    h.role = "dispatcher";
    h.router = { status: "pending", location: { pathname: "/settings/billing" } };
    RoleGuard();
    expect(h.navigations).toEqual([]);
  });

  it("does nothing while the role is still loading", () => {
    h.loading = true;
    h.router = settledOn("/settings/billing");
    RoleGuard();
    expect(h.navigations).toEqual([]);
  });

  it("redirects once, replacing history, when the router is idle on the gated page", () => {
    const cases: Array<[string, string, string]> = [
      ["dispatcher", "/settings/billing", "/dashboard"],
      ["dispatcher", "/invoices", "/dashboard"],
      ["office_manager", "/settings/billing", "/dashboard"],
      ["tech", "/settings/billing", "/my-day"],
      ["tech", "/invoices", "/my-day"],
    ];
    for (const [role, path, home] of cases) {
      h.navigations = [];
      h.toasts = [];
      h.role = role;
      h.router = settledOn(path);
      RoleGuard();
      expect(h.navigations, `${role} on ${path}`).toEqual([{ to: home, replace: true }]);
      expect(h.toasts, `${role} on ${path}`).toEqual(["You don't have access to that page."]);
    }
  });

  it("the same navigation, followed through: silent in flight, one redirect once settled", () => {
    h.role = "dispatcher";
    h.router = inFlight("/dashboard", "/invoices");
    RoleGuard();
    h.router = settledOn("/invoices");
    RoleGuard();
    expect(h.navigations).toEqual([{ to: "/dashboard", replace: true }]);
  });

  it("leaves a role that may open the page alone", () => {
    for (const [role, path] of [
      ["owner", "/settings/billing"],
      ["office_manager", "/invoices"],
      ["tech", "/my-day"],
      ["dispatcher", "/dashboard"],
    ]) {
      h.role = role;
      h.router = settledOn(path);
      RoleGuard();
    }
    expect(h.navigations).toEqual([]);
    expect(h.toasts).toEqual([]);
  });

  it("still ends the session's view of the business when access is turned off", () => {
    h.role = "dispatcher";
    h.accessTurnedOff = true;
    h.router = inFlight("/dashboard", "/clients");
    RoleGuard();
    expect(h.navigations).toEqual([{ to: "/access-off", replace: true }]);
  });
});
