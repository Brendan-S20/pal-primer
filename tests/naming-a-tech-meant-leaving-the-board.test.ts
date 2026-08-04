// "You shouldn't have to go to settings to say who's a tech."
//
// `is_field_tech` decides whether somebody gets a lane on the route board, a
// drop target, and an entry in every assign control on the page. The only
// place to set it was Settings → Team — two navigations away from the board
// where you actually notice it is wrong, because noticing it *is* seeing a new
// hire with no column, or somebody off the trucks who still has one.
//
// The board now carries a Crew popover and, on a lane belonging to somebody
// holding work they cannot be assigned, a one-click "Let them run routes".
//
// What these guard is the gate. `setStaffRouting` requires `manage_users` and
// refuses regardless of what the UI shows — so a dispatcher must get no
// switch, rather than a switch that throws after they press it. That is the
// part a future edit can quietly undo.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const PAGE = readFileSync(join(root, "src/routes/_authenticated/routes.tsx"), "utf8");
const FN = readFileSync(join(root, "src/lib/users.functions.ts"), "utf8");

/** Comments in the page describe the very thing being asserted, so they have
 *  to go first — otherwise the prose satisfies the test. */
const page = PAGE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the routing crew is set from the board", () => {
  it("calls setStaffRouting rather than linking to Settings", () => {
    expect(page).toMatch(/useServerFn\(setStaffRouting\)/);
  });

  it("gates every crew control on manage_users", () => {
    // One derivation, used by both the popover and the lane button. Two
    // separate checks is how one of them ends up ungated.
    const derivations = page.match(/const canManageCrew = canDo\("manage_users"\)/g) ?? [];
    expect(derivations).toHaveLength(1);

    // Both surfaces are conditional on it.
    const gated = page.match(/canManageCrew\s*(\?|&&)/g) ?? [];
    expect(gated.length).toBeGreaterThanOrEqual(3);
  });

  it("never renders a crew switch outside that gate", () => {
    // The popover must sit INSIDE `{canManageCrew && (`, not merely near it.
    const start = page.indexOf("{canManageCrew && (");
    expect(start).toBeGreaterThan(-1);
    const switchAt = page.indexOf("runs routes`}", start);
    expect(switchAt).toBeGreaterThan(start);
  });

  it("redraws the board after the flag changes", () => {
    // The lanes ARE the staff list, and a stranded lane stops being stranded
    // the moment the flag flips — so both queries have to be invalidated or
    // the board keeps showing the state you just changed.
    const body = page.slice(page.indexOf("const routingMut"), page.indexOf("const warnRoute"));
    expect(body).toMatch(/invalidateQueries\(\{ queryKey: \["staff"\] \}\)/);
    expect(body).toMatch(/invalidateQueries\(\{ queryKey: \["visits"\] \}\)/);
  });
});

describe("the server is the actual gate", () => {
  it("requires manage_users, not just an org membership", () => {
    const body = FN.slice(
      FN.indexOf("export const setStaffRouting"),
      FN.indexOf("export const listStaffAddresses"),
    );
    expect(body).toMatch(/requirePermission\(context\.supabase, context\.userId, "manage_users"\)/);
    // Scoped to the caller's own org on the way out, so a valid staffId from
    // another tenant updates nothing.
    expect(body).toMatch(/\.eq\("organization_id", orgId\)/);
  });

  it("marks the choice as deliberate so reconciliation cannot undo it", () => {
    // Migration 20260717220000 reconciles is_field_tech from role. Without the
    // override flag it would revert anyone switched on from this popover the
    // next time it ran, and the dispatcher would find the lane gone.
    const body = FN.slice(
      FN.indexOf("export const setStaffRouting"),
      FN.indexOf("export const listStaffAddresses"),
    );
    expect(body).toMatch(/patch\.is_field_tech_overridden = true/);
  });
});
