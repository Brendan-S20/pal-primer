// Owner QA, 2026-08-19: "For the platform admin, there should be more of
// actions for Tenants, Plans, and Users." The survey that followed found one
// action that was not merely missing — it was the missing half of an action
// that already shipped.
//
// ── THE DOOR ──────────────────────────────────────────────────────────────
//
// `softDeleteTenant` writes `organizations.deleted_at` and nothing else. Three
// separate things then hide the tenant, and together they close the door:
//
//   the list      listPlatformTenants filtered `.is("deleted_at", null)` and
//                 did not even return the column, so the row left the console.
//                 There was no "deleted" filter to bring it back and no badge
//                 that would have shown one if there were.
//
//   the page      /platform/tenants/$id still LOADS a deleted tenant —
//                 getTenantDetail does not filter on deleted_at — but every
//                 control on it is `disabled={!!t.deleted_at}`: impersonate,
//                 reactivate, grace, suspend, and the overflow menu the delete
//                 itself lives in. The page was readable and inert.
//
//   the server    there was no inverse. Nothing in src/ or in the migrations
//                 ever writes `deleted_at` back to NULL for an organization.
//
// So the only route back to a tenant deleted by mistake was for somebody to
// have kept its uuid, paste it into the address bar, read the page, and then
// find that there was nothing there to press. A platform admin acting on the
// wrong row affects a real business's real data, and this one could not be
// undone from inside the product at all.
//
// The fix is deliberately the exact inverse and no more: `restoreTenant` sets
// `deleted_at` back to NULL, audits it, and touches nothing else — a tenant
// that was suspended when it was deleted comes back suspended, because
// soft-delete never changed that either. `include_deleted` re-opens the list
// so the button can be reached, and stays off by default because the tenants
// page is the working view of who is live.
//
// ── AND ONE SIBLING ON THE SAME PAGE ──────────────────────────────────────
//
// Support notes were deleted by a bare trash glyph with no confirmation and no
// toast — `onClick={() => delM.mutate(n.id)}` — on a page whose other
// destructive action makes you type the organization's name. `deleteTenantNote`
// removes the row outright; support notes are not versioned and there is no
// undo. Same class of defect, one line of JSX away.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = new URL("..", import.meta.url).pathname;
const read = (p: string) => readFileSync(ROOT + p, "utf8");

/** Negative assertions run against source with comment lines stripped, so the
 *  prose above a fix cannot satisfy or defeat the assertion about the fix. */
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

const tenantFns = read("src/lib/platform-tenant.functions.ts");
const overviewFns = read("src/lib/platform-overview.functions.ts");
const detailRoute = read("src/routes/platform.tenants.$id.tsx");
const listRoute = read("src/routes/platform.tenants.index.tsx");

/** The body of one `export const NAME = createServerFn(...)` — up to the next
 *  top-level export, which is where the next server function starts. */
function serverFnBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  if (start === -1) return "";
  const rest = src.slice(start + 10);
  const next = rest.indexOf("\nexport const ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("soft-delete has an inverse", () => {
  it("ships a restoreTenant server function", () => {
    // The whole defect in one assertion: before this, nothing anywhere wrote
    // organizations.deleted_at back to NULL.
    expect(codeOnly(tenantFns)).toMatch(/export const restoreTenant = createServerFn/);
  });

  it("restores deleted_at to NULL and nothing else", () => {
    const body = codeOnly(serverFnBody(tenantFns, "restoreTenant"));
    expect(body).toMatch(/deleted_at:\s*null/);
    // Soft-delete did not touch these, so its inverse must not either — a
    // tenant suspended at the moment it was deleted comes back suspended.
    for (const column of [
      "billing_status",
      "plan_status",
      "suspended_at",
      "suspended_reason",
      "grace_expires_at",
      "plan_id",
    ]) {
      expect(body, `restoreTenant must not write ${column}`).not.toMatch(
        new RegExp(`${column}\\s*:`),
      );
    }
  });

  it("writes an audit row naming the restore", () => {
    expect(codeOnly(serverFnBody(tenantFns, "restoreTenant"))).toMatch(/"restore_tenant"/);
  });

  it("refuses a tenant that is not deleted rather than writing a no-op", () => {
    expect(codeOnly(serverFnBody(tenantFns, "restoreTenant"))).toMatch(/if \(!org\.deleted_at\)/);
  });
});

describe("every platform-tenant server function is behind the same gate", () => {
  // The new action must not be the one that forgot. Written as a sweep rather
  // than as an assertion about restoreTenant so it also holds for the next one.
  const names = [...tenantFns.matchAll(/export const (\w+) = createServerFn/g)].map((m) => m[1]);

  it("finds the server functions to check", () => {
    expect(names).toContain("restoreTenant");
    expect(names.length).toBeGreaterThan(10);
  });

  for (const name of [...new Set(names)]) {
    it(`${name} calls assertPlatformAdmin`, () => {
      expect(codeOnly(serverFnBody(tenantFns, name))).toMatch(/await assertPlatformAdmin\(/);
    });
  }
});

describe("a deleted tenant can be found again", () => {
  it("listPlatformTenants can be asked to include them", () => {
    const body = codeOnly(serverFnBody(overviewFns, "listPlatformTenants"));
    expect(body).toMatch(/include_deleted/);
    // The filter has to be conditional. An unconditional `.is("deleted_at",
    // null)` is exactly the line this fixes.
    expect(body).toMatch(/if \(!data\.include_deleted\)[\s\S]{0,120}is\("deleted_at", null\)/);
  });

  it("keeps them out by default", () => {
    const body = codeOnly(serverFnBody(overviewFns, "listPlatformTenants"));
    // include_deleted is optional and falsy when absent, so the working view
    // of live tenants is unchanged for every existing caller.
    expect(codeOnly(overviewFns)).toMatch(/include_deleted: z\.boolean\(\)\.optional\(\)/);
    expect(body).not.toMatch(/include_deleted:\s*true/);
  });

  it("returns deleted_at on the row so the console can show it", () => {
    const type = overviewFns.slice(
      overviewFns.indexOf("export type PlatformTenantRow"),
      overviewFns.indexOf("export const listPlatformTenants"),
    );
    expect(type).toMatch(/deleted_at: string \| null/);
  });

  it("offers a deleted filter on the tenants list", () => {
    const code = codeOnly(listRoute);
    expect(code).toMatch(/include_deleted/);
    expect(code).toMatch(/<option value=\{DELETED_FILTER\}>/);
  });

  it("marks the deleted rows as deleted in both layouts", () => {
    // Mobile card list and desktop table are separate JSX in this file; a
    // badge in one of them is a phone or a laptop showing a live-looking row.
    const code = codeOnly(listRoute);
    const badges = [...code.matchAll(/r\.deleted_at &&\s*\(?\s*<Badge variant="destructive"/g)];
    expect(badges.length).toBeGreaterThanOrEqual(2);
  });

  it("never offers to suspend or unsuspend a deleted tenant", () => {
    const code = codeOnly(listRoute);
    expect(code).toMatch(/const suspendable = [^\n]*!r\.deleted_at/);
    expect(code).toMatch(/const unsuspendable = [^\n]*!r\.deleted_at/);
  });
});

describe("restore is reachable from the page it is needed on", () => {
  /** The restore control and its dialog: from the `{t.deleted_at && (` that
   *  guards it to the `</AlertDialog>` that ends it. Scoped rather than a
   *  window of characters, because the button immediately after it is the
   *  Impersonate one and it legitimately carries `!!t.deleted_at`. */
  const restoreBlock = (() => {
    const code = codeOnly(detailRoute);
    const open = code.indexOf("{t.deleted_at && (");
    if (open === -1) return "";
    const close = code.indexOf("</AlertDialog>", open);
    return close === -1 ? "" : code.slice(open, close);
  })();

  it("renders a restore control", () => {
    expect(detailRoute).toMatch(/Restore tenant/);
    expect(restoreBlock, "no `{t.deleted_at && (` block on the page").not.toBe("");
    expect(restoreBlock).toMatch(/restoreM\.mutate\(\)/);
  });

  it("is the one control NOT disabled by deleted_at", () => {
    // Every other action on this page carries `disabled={!!t.deleted_at}`.
    // Copying that onto the restore button — on its own or or'd into the
    // pending check — is the obvious mistake and would leave the door exactly
    // as shut as it was.
    expect(restoreBlock).not.toMatch(/disabled=\{[^}]*!!t\.deleted_at[^}]*\}/);
    expect(restoreBlock).toMatch(/disabled=\{restoreM\.isPending\}/);
  });

  it("confirms with the tenant's own name, not a generic prompt", () => {
    expect(restoreBlock).toMatch(/AlertDialogTitle>\s*Restore \{t\.name\}\?/);
    expect(restoreBlock).not.toMatch(/Are you sure/i);
  });

  it("says what happened, naming the tenant", () => {
    expect(codeOnly(detailRoute)).toMatch(/toast\.success\(`\$\{t\.name\} restored/);
  });

  it("surfaces a failure instead of swallowing it", () => {
    const body = codeOnly(detailRoute).slice(
      codeOnly(detailRoute).indexOf("const restoreM = useMutation"),
    );
    expect(body.slice(0, 400)).toMatch(/onError: \(e\) => toast\.error\(/);
  });
});

describe("the other irreversible action on that page", () => {
  it("does not delete a support note on a single unguarded click", () => {
    expect(codeOnly(detailRoute)).not.toMatch(/onClick=\{\(\) => delM\.mutate\(n\.id\)\}/);
  });

  it("confirms with what is being deleted rather than a generic prompt", () => {
    const code = codeOnly(detailRoute);
    expect(code).toMatch(/title: "Delete this support note\?"/);
    expect(code).toMatch(/there is no undo/);
  });

  it("says so afterwards", () => {
    expect(codeOnly(detailRoute)).toMatch(/toast\.success\("Note deleted"\)/);
  });
});
