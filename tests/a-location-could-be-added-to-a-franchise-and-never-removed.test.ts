// A location could be added to a franchise and never removed.
//
// Owner QA, 2026-08-19: "Enterprise/Franchise doesn't fully function
// correctly." Linking and unlinking was one of the four areas named.
//
// ── WHAT WAS ACTUALLY BROKEN ──────────────────────────────────────────────
//
// There were two ways INTO a franchise and none out of it.
//
//   in    provision_franchise_location (ProvisionLocation) opens a location,
//         and create_franchise_link_code + redeem_franchise_link_code
//         (FranchiseLinkCodes, /settings/franchise) attach one that already
//         exists.
//
//   out   nothing. `unlink_franchise_child` shipped on 2026-07-30, is
//         SECURITY DEFINER, is granted to `authenticated`, and had no caller
//         anywhere in src/. Its only wrapper, `unlinkFranchiseLocation`, was
//         deleted on 2026-08-07 as one of the 28 unwired server functions, and
//         scripts/dead-machinery-baseline.json recorded why: the removal had
//         been hung off a row in the royalty ROLLUP table, which is a
//         reporting surface and the wrong place for an operation that ends a
//         live organization's membership. That reasoning was right, and the
//         consequence of stopping there was that ending a franchise link was
//         not possible from inside the product at all. A franchise that wanted
//         a location out had to ask HoundStack support to run the RPC by hand.
//
// The baseline entry said what to do about it in as many words: "Clear this by
// building the screen deliberately, with the consequences stated, not by
// re-adding a bare wrapper."
//
// ── WHERE THE SCREEN WENT, AND WHY IT IS NOT THE OLD ONE ──────────────────
//
// FranchiseLocationDrawer is the one screen in this product that is about ONE
// named location: the person doing this has already chosen which location and
// is looking at its statements and its money while they decide. That is the
// difference from the deleted version, which aimed at the sixth line of a
// table sorted by revenue.
//
// ── WHAT THESE TESTS PIN ──────────────────────────────────────────────────
//
// Three things, in the order they can go wrong.
//
// 1. That it is WIRED — the whole point of the exercise. Including that the
//    dead-machinery baseline no longer excuses the RPC, because an exemption
//    left behind after the thing is built is how the next unwired function
//    hides behind a stale reason.
//
// 2. That the confirmation is REAL — the location named, the consequences
//    stated in words rather than implied by a red button, and the name typed.
//    Checked on the server too: a confirmation a caller can skip by posting to
//    the server function is a confirmation in name only (guardrail 10.4).
//
// 3. That the authorization was not widened on the way in. Two prior security
//    migrations exist in this exact area (20260731230000, 20260801060000) and
//    the owner decision of 2026-07-30 is that a franchisee cannot detach
//    itself. The wrapper must not become the thing that lets them.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Negative assertions run against source with comment lines stripped, so the
 *  prose explaining a fix can neither satisfy nor defeat an assertion about
 *  the fix. Same helper, same reason, as the tenant-delete tests. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return (
        !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*") && !t.startsWith("{/*")
      );
    })
    .join("\n");

const membershipFns = read("src/lib/franchise-membership.functions.ts");
const drawer = read("src/components/FranchiseLocationDrawer.tsx");
const baseline = JSON.parse(read("scripts/dead-machinery-baseline.json"));

/** The body of one `export const NAME = createServerFn(...)`, up to the next
 *  top-level export. */
function serverFnBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  if (start === -1) return "";
  const rest = src.slice(start + 10);
  const next = rest.indexOf("\nexport const ");
  return next === -1 ? rest : rest.slice(0, next);
}

/** Every migration file, newest last — the order Postgres replays them in, so
 *  the last definition of a function is the live one. */
function migrations(): Array<{ name: string; sql: string }> {
  const dir = join(ROOT, "supabase/migrations");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ name: f, sql: readFileSync(join(dir, f), "utf8") }));
}

/** The last body given to a plpgsql function across the whole migration
 *  sequence. unlink_franchise_child is defined twice — 20260730130000 and then
 *  20260730160000, which narrows who may call it — and only the second one is
 *  what runs. */
function lastFunctionBody(name: string): string {
  let found = "";
  for (const m of migrations()) {
    const re = new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${name}\\s*\\([\\s\\S]*?\\n\\$\\$;`,
      "g",
    );
    for (const hit of m.sql.match(re) ?? []) found = hit;
  }
  return found;
}

const unlinkSql = lastFunctionBody("unlink_franchise_child");

describe("the removal exists at all", () => {
  it("has a TypeScript caller for unlink_franchise_child", () => {
    // The literal defect. Nothing in src/ referenced this RPC.
    expect(
      codeOnly(membershipFns),
      "removeFranchiseLocation must call the RPC — the SQL is the only thing that can perform this write",
    ).toContain('rpc("unlink_franchise_child"');
  });

  it("no longer carries a dead-machinery exemption for it", () => {
    // An exemption that outlives the thing it excused is how the NEXT unwired
    // function hides: the check goes green against a reason nobody rereads.
    expect(
      Object.keys(baseline.uncalled_rpcs ?? {}),
      "unlink_franchise_child is wired now, so the baseline must not still excuse it",
    ).not.toContain("unlink_franchise_child");
  });

  it("reaches it from a screen, not only from a server function", () => {
    const code = codeOnly(drawer);
    expect(code).toContain("removeFranchiseLocation");
    // A server function with no caller is the same defect one layer up.
    expect(code).toMatch(/useServerFn\(removeFranchiseLocation\)/);
  });

  it("puts it on the one screen that is about a single location", () => {
    // Not the rollup table. The deleted wrapper's fault was the placement, and
    // re-adding it to a reporting row would reproduce it exactly.
    const rollupPage = codeOnly(read("src/routes/_authenticated/franchise.tsx"));
    expect(
      rollupPage,
      "the removal must not be hung off a row in the royalty rollup table",
    ).not.toContain("removeFranchiseLocation");
  });
});

describe("the confirmation says what actually happens", () => {
  /** Copy assertions run against whitespace-flattened source: JSX prose wraps
   *  wherever the formatter puts it, and a sentence that moves half a word onto
   *  the next line has not changed what the reader is told. */
  const dialog = drawer.replace(/\s+/g, " ");

  it("names the location rather than saying 'this location'", () => {
    expect(dialog).toMatch(/Remove \{row\.organization_name\} from this franchise\?/);
  });

  it("states, in words, that what was already billed survives the removal", () => {
    // unlink_franchise_child preserves every statement and adjustment on
    // purpose — "unlinking is not a way to erase what was owed". A franchise
    // owner who believes the opposite is one press away from a very expensive
    // misunderstanding, in either direction.
    expect(dialog).toMatch(/already raised are kept/i);
    expect(dialog).toMatch(/still unpaid is still owed/i);
  });

  it("states that the royalty stops", () => {
    expect(dialog).toMatch(/royalty rate is set back to 0%/i);
    expect(dialog).toMatch(/no new settlement statement/i);
  });

  it("states that it cannot be undone from here, and what re-linking costs", () => {
    expect(dialog).toMatch(/cannot be undone/i);
    // Re-linking is not an undo: a fresh code, redeemed by the location's own
    // owner. Consent is the whole design of the link (BUG-19), so it has to be
    // given again.
    expect(dialog).toMatch(/issue a new invitation code and their owner redeems it/i);
  });

  it("says that HoundStack does not tell the location", () => {
    // Nothing in this repo sends mail on unlink. Silence a franchise owner
    // assumes is a notification is silence the franchisee never hears.
    expect(dialog).toMatch(/HoundStack does not tell them/i);
  });

  it("requires the location's name to be typed before the button works", () => {
    const code = codeOnly(drawer);
    expect(code).toMatch(/typed\.trim\(\)\s*===\s*row\.organization_name\.trim\(\)/);
    expect(code).toMatch(/disabled=\{!nameMatches \|\| remove\.isPending\}/);
  });

  it("checks the typed name on the SERVER as well", () => {
    // Guardrail 10.4. The dialog is a courtesy; the server function is the
    // boundary, and it is one fetch away from anybody holding a session.
    const body = codeOnly(serverFnBody(membershipFns, "removeFranchiseLocation"));
    expect(body).toContain("confirmName");
    expect(body).toMatch(/name\.trim\(\)\s*!==\s*data\.confirmName\.trim\(\)/);
  });
});

describe("nothing about who may do this got wider", () => {
  it("keeps the removal owner-level in TypeScript", () => {
    const body = codeOnly(serverFnBody(membershipFns, "removeFranchiseLocation"));
    // manage_franchise is owner-only in ROLE_PERMISSIONS — office_manager is
    // filtered out of it explicitly. manage_settings, which the rest of this
    // file uses, is NOT: it admits office managers.
    expect(body).toContain('"manage_franchise"');
    expect(body).not.toContain('"manage_settings"');
  });

  it("refuses a location that is not this caller's, before touching anything", () => {
    const body = codeOnly(serverFnBody(membershipFns, "removeFranchiseLocation"));
    // The service-role read is only safe because it is pinned to the real
    // relationship. Without this the function is a way to ask whether an
    // arbitrary uuid is an organization and what it is called.
    expect(body).toMatch(/child\.parent_organization_id !== orgId/);
    expect(body).toContain("That location is not part of your franchise.");
  });

  it("lets the SQL decide, on the caller's own client", () => {
    const body = codeOnly(serverFnBody(membershipFns, "removeFranchiseLocation"));
    // auth.uid() inside the SECURITY DEFINER routine has to be the real person
    // — it re-authorizes independently. supabaseAdmin here would make it null
    // and the routine could not tell who was removing whom.
    expect(body).toMatch(/context\.supabase as any\)\.rpc\("unlink_franchise_child"/);
    expect(body).not.toMatch(/supabaseAdmin as any\)\.rpc\("unlink_franchise_child"/);
  });

  it("still refuses the child side in SQL — the 2026-07-30 owner decision", () => {
    // "Membership is the parent's to grant and the parent's to end." A wrapper
    // is not allowed to be the thing that quietly gives a franchisee a way out
    // of a contract, so this pins the live definition rather than trusting that
    // nobody will redefine it.
    expect(unlinkSql, "unlink_franchise_child not found in the migrations").not.toBe("");
    expect(unlinkSql).toContain("_caller_org = _parent");
    expect(unlinkSql).toContain("public.is_platform_admin(auth.uid())");
    expect(
      unlinkSql,
      "the live definition must not admit the CHILD's own owner",
    ).not.toContain("_caller_org = _child_org_id");
  });

  it("does not paywall the exit, on either side of the boundary", () => {
    // Deliberate, and the two layers have to agree. A plan may withhold a
    // capability; it must not lock an organization INSIDE a relationship, and
    // a franchise whose Enterprise plan lapses must still be able to let a
    // location go. The SQL takes the same view — create_franchise_link_code
    // and provision_franchise_location both carry has_plan_entitlement and
    // this one does not — so a requireEntitlement here would be the TypeScript
    // layer refusing something the database allows, which is the exact fault
    // class this whole area keeps producing.
    const body = codeOnly(serverFnBody(membershipFns, "removeFranchiseLocation"));
    expect(body).not.toContain("requireEntitlement");
    expect(unlinkSql).not.toContain("has_plan_entitlement");
  });
});

describe("the parent's own row is not a location", () => {
  it("hides the control unless the row is a child of this franchise", () => {
    // franchise_rollup returns the franchise's OWN numbers as the first row, so
    // this drawer opens on the parent too. Offering a control that can only
    // ever fail is its own defect.
    const code = codeOnly(drawer);
    expect(code).toMatch(/const isLocation =[\s\S]{0,120}parentOrgId !== row\.organization_id/);
    expect(code).toMatch(/if \(!isLocation\) return null;/);
  });

  it("takes the parent's id from the rollup's own query key", () => {
    // The drawer's founding rule is that it adds no second answer to a question
    // the page already answers. Same key, same cache entry.
    const code = codeOnly(drawer);
    expect(code).toMatch(/queryKey: \["franchise", "rollup"\]/);
  });

  it("fails towards no button when that id is not known yet", () => {
    const code = codeOnly(drawer);
    expect(code).toMatch(/rollup\.data\?\.parentOrgId \?\? null/);
    expect(code).toMatch(/const isLocation = !!parentOrgId/);
  });
});
