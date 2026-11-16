// The join form was offered to exactly the people the SQL refuses.
//
// Owner decision, 2026-08-19: joining is owner-only, matching the SQL, and the
// form is not shown to anyone who cannot use it.
//
// ── THE MISMATCH ──────────────────────────────────────────────────────────
//
// `redeem_franchise_link_code` requires `owner`. `joinFranchise` gated on
// `manage_settings`, which office_manager holds. So an office manager got a
// Join-a-franchise card in full working order — label, code field, enabled
// button — and the only way to find out it was not for them was to type a real
// invitation code into it and be told "Only the owner can join a franchise."
//
// The file header claimed "Owner-only on both sides, enforced in SQL as well as
// here". It was true of the SQL and false of the here.
//
// `manage_franchise` is how this codebase spells owner-only: ROLE_PERMISSIONS
// gives it to owner and to nobody else, which
// tests/franchise-reads-are-not-for-everyone already pins.
//
// ── WHY THE READ IS NOT NARROWED WITH IT ──────────────────────────────────
//
// `getMyFranchiseMembership` stays on `manage_settings`, deliberately, and this
// file asserts that rather than leaving it to drift. It is the page's read, not
// the act the SQL restricts, and the page shows an office manager three things
// they are entitled to: the royalty rate, the settlement statements and the
// adjustment trail — the last two gated on `view_financials`, which
// office_manager holds, and both MOUNTED on the answer to this call.
//
// Narrowing it would not even hide the form. The page falls through to the join
// card when the membership query returns nothing, so an owner-only read would
// show a non-owner MORE of the form, not less.
//
// So the read answers the question the page needs — `canJoin`, computed from
// the caller's own role on the server. That flag is presentation. The
// authorization is `joinFranchise`, and then the SQL, in that order.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ROLE_PERMISSIONS } from "../src/lib/permissions";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");

const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");

const fns = codeOnly(read("src/lib/franchise-membership.functions.ts"));
const page = codeOnly(read("src/routes/_authenticated/settings.franchise.tsx"));

describe("joining is owner-only on this side too", () => {
  it("gates joinFranchise on the owner-only permission", () => {
    const fn = fns.slice(fns.indexOf("export const joinFranchise"));
    const handler = fn.slice(0, fn.indexOf("export const", 10));
    expect(handler, "joinFranchise still admits a role the SQL underneath it refuses").toMatch(
      /requirePermission\(context\.supabase, context\.userId, "manage_franchise"\)/,
    );
    expect(handler).not.toMatch(/"manage_settings"/);
  });

  it("relies on a permission only the owner has", () => {
    // The assertion above is worth nothing if manage_franchise ever widens.
    expect(ROLE_PERMISSIONS.owner).toContain("manage_franchise");
    for (const role of ["office_manager", "dispatcher", "tech"] as const) {
      expect(ROLE_PERMISSIONS[role], role).not.toContain("manage_franchise");
    }
  });

  it("still lets the SQL decide independently", () => {
    // The server function is the app's gate; redeem_franchise_link_code checks
    // owner again on the caller's own client, which is why this runs there
    // rather than on the service-role client.
    const fn = fns.slice(fns.indexOf("export const joinFranchise"));
    expect(fn).toMatch(/context\.supabase as any\)\.rpc\(\s*"redeem_franchise_link_code"/);
  });
});

describe("the page does not offer what the server will refuse", () => {
  it("asks the server whether THIS caller can join", () => {
    expect(fns).toMatch(/canJoin: hasPermission\(role, "manage_franchise", overrides\)/);
  });

  it("gates the form on that answer", () => {
    expect(page).toMatch(/!m\?\.canJoin \?/);
  });

  it("tells a non-owner what the capability is and who has it", () => {
    // A blank space where a colleague's screen has a card is a support call.
    const block = page.slice(page.indexOf("!m?.canJoin ?"));
    expect(block.slice(0, 700)).toMatch(/only an owner can accept an invitation code/i);
  });

  it("keeps the form itself for an owner", () => {
    expect(page).toMatch(/Join franchise/);
    expect(page).toMatch(/joinFn\(\{ data: \{ code \} \}\)/);
  });

  it("does not narrow the read the ledgers are mounted on", () => {
    // office_manager holds view_financials and is meant to see the statements
    // and the adjustment trail. Both are mounted on this call's answer, so
    // making it owner-only would take them away from a role the product
    // deliberately shows them to — and would show the join form to MORE people,
    // because the page falls through when the query returns nothing.
    const fn = fns.slice(fns.indexOf("export const getMyFranchiseMembership"));
    expect(fn.slice(0, 600)).toMatch(/"manage_settings"/);
    expect(page).toMatch(/const showLedgers = !!m && \(m\.isChild \|\| m\.hasFranchiseHistory\)/);
  });
});

describe("the location's copy of a statement carries the same figures as the parent's", () => {
  it("selects the collector split", () => {
    // net = |collected_by_franchise − royalty − adjustments|. Without this
    // column the location is given revenue, royalty and adjustments and a net
    // that follows from none of them on a period the franchise collected part
    // of. The parent's query has selected it since 2026-08-19.
    const fn = fns.slice(fns.indexOf("export const getMyFranchiseSettlements"));
    const select = /\.select\(\s*"([^"]+)"/.exec(fn);
    expect(select, "no select found on getMyFranchiseSettlements").toBeTruthy();
    expect(select![1].split(/,\s*/)).toContain("revenue_collected_by_parent_cents");
  });

  it("does not start handing the location a draft", () => {
    // Issuing is what delivers a statement; a draft is a figure still moving.
    const fn = fns.slice(fns.indexOf("export const getMyFranchiseSettlements"));
    expect(fn).toMatch(/\.neq\("status", "draft"\)/);
    expect(fn).toMatch(/\.eq\("child_organization_id", orgId\)/);
  });

  it("keeps reading money lines behind view_financials", () => {
    const fn = fns.slice(fns.indexOf("export const getMyFranchiseSettlements"));
    expect(fn).toMatch(
      /requirePermission\(context\.supabase, context\.userId, "view_financials"\)/,
    );
  });
});

describe("removing a location stays outside the paywall", () => {
  it("has no entitlement check, deliberately", () => {
    // Preserved on purpose: a paywall may withhold a capability but must not
    // lock an organization inside a relationship. The SQL agrees —
    // unlink_franchise_child has no has_plan_entitlement either.
    const fn = fns.slice(fns.indexOf("export const removeFranchiseLocation"));
    expect(fn).not.toMatch(/requireEntitlement/);
    expect(fn).toMatch(
      /requirePermission\(context\.supabase, context\.userId, "manage_franchise"\)/,
    );
  });

  it("still checks the typed name on the server", () => {
    // A confirmation a caller can skip by posting to the server function
    // directly is a confirmation in name only.
    const fn = fns.slice(fns.indexOf("export const removeFranchiseLocation"));
    expect(fn).toMatch(/confirmName/);
    expect(fn).toMatch(/name\.trim\(\) !== data\.confirmName\.trim\(\)/);
  });
});
