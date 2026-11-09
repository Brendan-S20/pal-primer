import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/lib/org.functions", () => ({ getMyOrg: vi.fn() }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: (f: unknown) => f }));

import { deniedRouteDestination } from "@/hooks/useMyRole";

// #682. Every role-gated hit logged
//   TypeError: Cannot read properties of undefined (reading '_nonReactive')
// and the redirect still worked.
//
// The stack was RouterCore.preloadRoute -> loadMatches -> loadRouteMatch.
// The refused page rendered inside the shell, the mobile tab bar's
// preload="render" links started a preload per tab, and RoleGuard navigated
// away while those were still running; each preload then finished with
// `router.getMatch(id)._nonReactive` on a match the navigation had dropped.
// RoleGuard also read `location.pathname`, which the router sets as soon as a
// navigation STARTS, so it could navigate over a load in flight too.
//
// Reproduced and checked in a browser on the stubbed backend (dispatcher on
// /invoices and /settings/billing, office manager on /settings/billing, tech
// on /invoices): two TypeErrors per hard load before, none after.
//
// The fix, which this pins:
// - AppShell mounts neither the shell nor the page for a refused route, the
//   way it already does for a client-only alias, so nothing preloads;
// - RoleGuard reads the RESOLVED location, and only once the router is idle.
// A beforeLoad redirect from the layout was tried and is the wrong tool: a
// redirect thrown by _authenticated to a page under it leaves the shared
// layout match "redirected" with no promise to suspend on, and the root
// error boundary draws "This page didn't load".

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

describe("a role gate does not navigate over a load in flight", () => {
  it("sends each role to its home, and lets an allowed role through", () => {
    expect(deniedRouteDestination("dispatcher", "/invoices")).toBe("/dashboard");
    expect(deniedRouteDestination("dispatcher", "/settings/billing")).toBe("/dashboard");
    expect(deniedRouteDestination("office_manager", "/settings/billing")).toBe("/dashboard");
    expect(deniedRouteDestination("tech", "/invoices")).toBe("/my-day");
    expect(deniedRouteDestination("tech", "/dashboard")).toBe("/my-day");
    expect(deniedRouteDestination("owner", "/settings/billing")).toBeNull();
    expect(deniedRouteDestination("office_manager", "/invoices")).toBeNull();
    expect(deniedRouteDestination("tech", "/my-day")).toBeNull();
    // Not guarded at all, and no role yet: nothing to decide.
    expect(deniedRouteDestination("tech", "/some-unlisted-page")).toBeNull();
    expect(deniedRouteDestination(null, "/invoices")).toBeNull();
  });

  it("a refused page mounts neither the shell nor the page", () => {
    const src = read("src/routes/_authenticated/route.tsx");
    const shell = src.slice(
      src.indexOf("function AppShell()"),
      src.indexOf("function WorkspaceShell()"),
    );
    expect(shell).toMatch(/deniedRouteDestination\(role, drawnPath\)/);
    expect(shell).toMatch(
      /if \(denied\) \{\s*return \(\s*<>\s*<ShellPending \/>\s*<RoleGuard \/>\s*<\/>/,
    );
    expect(shell.indexOf("if (denied)")).toBeLessThan(shell.indexOf("return <WorkspaceShell />"));
    // Not a redirect thrown from the layout's beforeLoad (see above).
    expect(src).not.toMatch(/deniedRouteDestination[\s\S]{0,400}throw redirect/);
  });

  it("RoleGuard reads the resolved location, not the one a navigation just set", () => {
    const src = read("src/components/RoleGuard.tsx");
    expect(src).toMatch(/r\.status === "idle" \? r\.resolvedLocation\?\.pathname/);
    expect(src).not.toMatch(/r\.location\.pathname/);
  });
});
