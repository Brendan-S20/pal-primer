// ── THE CONCESSION THAT OUTLIVED THE PROBLEM ──────────────────────────────
//
// `grantGracePeriod` writes ONE column that matters: `grace_expires_at`. Its
// own comment says so — "grace_expires_at is what org_can_add_client honors;
// billing_status is display-only" — and the gate agrees. Since
// 20260713120000_entitlement-gate-recovery.sql, and unchanged through the two
// rewrites since, `org_can_add_client` reads:
//
//     WHEN o.plan_status IN ('active', 'past_due')            THEN true
//     …
//     WHEN o.grace_expires_at IS NOT NULL
//          AND o.grace_expires_at > now()                     THEN true
//     ELSE false
//
// That last branch is its own branch. It does not consult billing_status,
// plan_status, suspended_at or anything else — a live `grace_expires_at` is
// sufficient on its own.
//
// `reactivateTenant` cleared `suspended_at` and `suspended_reason` and did not
// clear `grace_expires_at`. So a tenant suspended for non-payment, given two
// weeks of grace to sort it out, and then reactivated came out the far side
// still holding those two weeks: a client-limit allowance nobody re-granted,
// invisible on the console except as a date three tabs away on Overview, and
// expiring on a day some admin picked for a different reason weeks earlier.
//
// And there was no way to take one back. `grantGracePeriod` is the only writer
// of the column in the whole repo, `z.number().int().min(1)` is its floor, so
// the shortest correction available was another whole day of the same
// concession. Nothing anywhere wrote `grace_expires_at` back to NULL.
//
// ── THE OWNER'S DECISION, 2026-08-19 ──────────────────────────────────────
//
//     "Clear grace on reactivate, and add End grace."
//
// So both halves: reactivation ends the concession with the problem it was
// covering, and there is an explicit action to revoke one without reactivating.
//
// ── WHAT THIS FILE IS WATCHING FOR ────────────────────────────────────────
//
// The plausible wrong fix is putting the clear in `suspendTenant` — it is the
// other lifecycle action, it is adjacent in the file, and a tenant being
// suspended does look like a moment to tidy up. It is exactly backwards: a
// suspension is when a grace period is most likely to have just been granted
// (the Grant grace button is shown precisely when billing_status is not
// active or free), and clearing it there revokes the concession at the moment
// it was extended. The sweep at the bottom of this file names every column
// each lifecycle action may write, so that mutation fails.
//
// The other plausible wrong fix is hiding End grace once the window has
// lapsed. See "an expired grace period is still a thing on the record" below.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Negative assertions run against source with comment lines stripped, so the
 *  prose above a fix cannot satisfy or defeat the assertion about the fix. */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(
        t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")
      );
    })
    .join("\n");

const tenantFns = read("src/lib/platform-tenant.functions.ts");
const detailRoute = read("src/routes/platform.tenants.$id.tsx");
const gateMigration = read(
  "supabase/migrations/20260814010000_deleting-a-tenant-left-their-signup-page-taking-cards.sql",
);

/** The body of one `export const NAME = createServerFn(...)` — up to the next
 *  top-level export, which is where the next server function starts. */
function serverFnBody(src: string, name: string): string {
  const start = src.indexOf(`export const ${name} = createServerFn`);
  if (start === -1) return "";
  const rest = src.slice(start + 10);
  const next = rest.indexOf("\nexport const ");
  return next === -1 ? rest : rest.slice(0, next);
}

/** The `const patch = { … }` object literal a handler hands to `.update()`.
 *  Asserting on this rather than on the whole body is the point: every one of
 *  these handlers READS columns it must not WRITE, so a body-wide grep for
 *  `plan_status` cannot tell a select list from an update. */
function patchLiteral(body: string): string {
  const i = body.indexOf("const patch = {");
  if (i === -1) return "";
  const open = body.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < body.length; j += 1) {
    if (body[j] === "{") depth += 1;
    else if (body[j] === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(open, j + 1);
    }
  }
  return "";
}

describe("the gate this is all about still reads the column on its own", () => {
  it("org_can_add_client honours a live grace window regardless of billing state", () => {
    // If this ever stops being true the rest of the file is arguing about
    // nothing — and if it changes, it changes in a migration, not here.
    expect(gateMigration).toMatch(
      /WHEN o\.grace_expires_at IS NOT NULL AND o\.grace_expires_at > now\(\) THEN true/,
    );
  });
});

describe("reactivating ends the concession with the problem", () => {
  const body = codeOnly(serverFnBody(tenantFns, "reactivateTenant"));

  it("clears grace_expires_at", () => {
    // The defect in one assertion.
    expect(patchLiteral(body)).toMatch(/grace_expires_at:\s*null/);
  });

  it("clears it unconditionally, not only when the tenant looks like it is in grace", () => {
    // billing_status is display-only here, and a tenant can hold a live
    // grace_expires_at while reading "canceled" — grantGracePeriod is the only
    // writer of the column and nothing keeps the two in step afterwards. A
    // clear guarded on `before?.billing_status === "grace"` leaves exactly the
    // rows this is about.
    expect(body).not.toMatch(/billing_status === "grace"/);
    expect(patchLiteral(body)).toMatch(/grace_expires_at:\s*null/);
  });

  it("reads the old value first so the audit row can show what was given up", () => {
    expect(body).toMatch(/\.select\("[^"]*grace_expires_at[^"]*"\)/);
  });
});

describe("an explicit End grace, so a concession can be revoked on its own", () => {
  const body = codeOnly(serverFnBody(tenantFns, "endGracePeriod"));

  it("exists at all", () => {
    // Before this, `grantGracePeriod` was the only writer of the column in the
    // repo and its minimum was a whole further day.
    expect(codeOnly(tenantFns)).toMatch(/export const endGracePeriod = createServerFn/);
  });

  it("is behind the same platform-admin gate as everything else on the page", () => {
    expect(body).toMatch(/await assertPlatformAdmin\(/);
  });

  it("writes grace_expires_at back to NULL", () => {
    expect(patchLiteral(body)).toMatch(/grace_expires_at:\s*null/);
  });

  it("does not touch plan_status — ending a concession is not a plan change", () => {
    // plan_status is what the gate reads for everything EXCEPT grace. Moving
    // it here would make End grace either a reactivation or a suspension in
    // disguise, depending on which way it moved.
    expect(patchLiteral(body)).not.toMatch(/plan_status\s*:/);
  });

  it("refuses a tenant with no grace period rather than writing a no-op", () => {
    // "There was nothing to end" and "it is ended" must not look the same.
    expect(body).toMatch(/if \(!before\.grace_expires_at\)\s*throw new Error\(/);
  });

  it("writes an audit row naming the action, with the date it revoked", () => {
    expect(body).toMatch(/"end_grace_period"/);
    expect(body).toMatch(/grace_expires_at: before\.grace_expires_at/);
  });

  it("tells the caller whether the window was still live", () => {
    // The difference between revoking something and clearing a stale date.
    expect(body).toMatch(/was_live/);
    expect(body).toMatch(/new Date\(before\.grace_expires_at\)\.getTime\(\) > Date\.now\(\)/);
  });

  it("does not leave a Grace badge up for a grace period it just ended", () => {
    expect(body).toMatch(/before\.billing_status === "grace"/);
    expect(patchLiteral(body)).toMatch(/billing_status:/);
  });
});

describe("every lifecycle action writes only the columns it is named for", () => {
  // Written as a sweep rather than as one assertion about suspendTenant,
  // because the mutation this is guarding against — clearing grace on the
  // wrong verb — has four places it could land.
  const allowed: Record<string, string[]> = {
    suspendTenant: ["billing_status", "suspended_at", "suspended_reason"],
    reactivateTenant: [
      "billing_status",
      "plan_status",
      "suspended_at",
      "suspended_reason",
      "grace_expires_at",
    ],
    grantGracePeriod: ["grace_expires_at", "billing_status"],
    endGracePeriod: ["grace_expires_at", "billing_status"],
    softDeleteTenant: ["deleted_at"],
    restoreTenant: ["deleted_at"],
  };
  const everyColumn = [
    "billing_status",
    "plan_status",
    "suspended_at",
    "suspended_reason",
    "grace_expires_at",
    "deleted_at",
    "plan_id",
  ];

  for (const [name, may] of Object.entries(allowed)) {
    it(`${name} writes ${may.join(", ")} and nothing else`, () => {
      const patch = patchLiteral(codeOnly(serverFnBody(tenantFns, name)));
      expect(patch, `no \`const patch = {\` in ${name}`).not.toBe("");
      for (const column of everyColumn) {
        const written = new RegExp(`\\b${column}\\s*:`).test(patch);
        expect(written, `${name} ${written ? "writes" : "does not write"} ${column}`).toBe(
          may.includes(column),
        );
      }
    });
  }
});

describe("End grace is reachable, and says what it will do", () => {
  const code = codeOnly(detailRoute);

  /** The End grace control and its dialog. `{t.grace_expires_at && (` guards
   *  two things on this page — the grace line in the header and this button —
   *  so scope to the occurrence that carries the control rather than to the
   *  first one, which would silently test the wrong block. */
  const block = (() => {
    for (let open = code.indexOf("{t.grace_expires_at && ("); open !== -1;
         open = code.indexOf("{t.grace_expires_at && (", open + 1)) {
      const close = code.indexOf("</AlertDialog>", open);
      if (close === -1) continue;
      const slice = code.slice(open, close);
      if (slice.includes("endGraceM.mutate()")) return slice;
    }
    return "";
  })();

  it("renders a control wired to the new action", () => {
    expect(code).toMatch(/endGracePeriod/);
    expect(block, "no `{t.grace_expires_at && (` block on the page").not.toBe("");
    expect(block).toMatch(/End grace/);
    expect(block).toMatch(/endGraceM\.mutate\(\)/);
  });

  it("an expired grace period is still a thing on the record, so the button still shows", () => {
    // The tempting version gates the button on the window being LIVE. An
    // expired one is inert to org_can_add_client but it still sets the Grace
    // badge and still prints a date on the Overview tab, so hiding the control
    // leaves an admin reading a concession with no way to clear it — the same
    // "nothing to press" dead end soft-delete used to be.
    expect(block).toMatch(/^\{t\.grace_expires_at && \(/);
    expect(code).not.toMatch(/\{graceLive && \(/);
  });

  it("confirms with the tenant's own name and the consequence, not a generic prompt", () => {
    expect(block).toMatch(/AlertDialogTitle>\s*End \{t\.name\}'s grace period\?/);
    expect(block).not.toMatch(/Are you sure/i);
    expect(block).toMatch(/graceLive \?/);
  });

  it("says two different things afterwards, because two different things happened", () => {
    const onSuccess = code.slice(code.indexOf("const endGraceM = useMutation"));
    expect(onSuccess.slice(0, 900)).toMatch(/res\.was_live/);
    expect(onSuccess.slice(0, 900)).toMatch(/Grace period ended for \$\{t\.name\}/);
    expect(onSuccess.slice(0, 900)).toMatch(/already lapsed/);
  });

  it("surfaces a failure instead of swallowing it", () => {
    const m = code.slice(code.indexOf("const endGraceM = useMutation"));
    expect(m.slice(0, 900)).toMatch(/onError: \(e\) => toast\.error\(/);
  });
});

describe("Reactivate now says the second thing it does", () => {
  const code = codeOnly(detailRoute);

  it("no longer fires on one unguarded click", () => {
    // It writes billing_status, plan_status, the suspension AND now the grace
    // period, and it did all of that from a bare `onClick`.
    expect(code).not.toMatch(/<Button size="sm" onClick=\{\(\) => reactivateM\.mutate\(\)\}/);
    expect(code).toMatch(/AlertDialogTitle>\s*Reactivate \{t\.name\}\?/);
  });

  it("names the grace period in the confirmation when there is one to lose", () => {
    const open = code.indexOf("Reactivate {t.name}?");
    const block = code.slice(open, code.indexOf("</AlertDialog>", open));
    expect(block).toMatch(/t\.grace_expires_at/);
    expect(block).toMatch(/grace period/i);
  });

  it("names the tenant in the toast, and mentions the grace it ended", () => {
    const m = code.slice(code.indexOf("const reactivateM = useMutation"));
    expect(m.slice(0, 700)).toMatch(/\$\{t\.name\} reactivated/);
    expect(m.slice(0, 700)).toMatch(/grace period was ended with it/);
  });
});
