// The Users half of the 2026-08-19 owner QA.
//
// `startImpersonation(organization_id, target_user_id)` is the platform admin's
// one real support lever: it mints a single-use, two-minute grant that a new
// tab exchanges for a tab-scoped session AS that user, without touching the
// admin's own session, and writes start/enter/stop rows to the audit trail.
//
// It had exactly one caller — the tenant detail page — and that page can only
// ever offer ONE tenant's users, from an unfiltered `<select>` of everybody in
// the organization.
//
// /platform/users is the only place in the console where a person can be found
// across every tenant. It is where you land when somebody emails support from
// an address and you do not know which organization they belong to. It already
// holds both halves of the grant on every row — `organizations[].id` and
// `user_id` — and shows them: the row links straight to /platform/tenants/$id.
// And the only things it could do with the person it had just found were auth
// account maintenance: reset a password, change an email or phone, drop MFA.
//
// So the action you actually want after finding someone was the one action you
// had to leave to perform: open their tenant, then find them again in a list of
// everybody in that tenant.
//
// ── WHAT DELIBERATELY DID NOT CHANGE ──────────────────────────────────────
//
// The server function, the platform-admin check inside it, the grant's TTL and
// single use, the tab-scoped session, and every audit row. This is the same
// call from a second screen, not a second way in. `launchImpersonationTab` is
// the same shared helper the tenant page uses, so the window handling that
// keeps the admin's own session out of it is not reimplemented here.
//
// A user can hold roles in more than one organization, and a grant is for one
// of them, so the screen has to ask which — picking the first silently would be
// impersonating someone inside a business nobody chose.

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf8");

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

const usersRoute = codeOnly(read("src/routes/platform.users.tsx"));
const platformFns = read("src/lib/platform.functions.ts");
const detailRoute = read("src/routes/platform.tenants.$id.tsx");

describe("the premise: the capability was already there and already gated", () => {
  it("startImpersonation takes an organization and a user, with no default", () => {
    const schema = platformFns.slice(
      platformFns.indexOf("const impersonateSchema"),
      platformFns.indexOf("export const startImpersonation"),
    );
    expect(schema).toMatch(/organization_id: z\.string\(\)\.uuid\(\)/);
    expect(schema).toMatch(/target_user_id: z\.string\(\)\.uuid\(\)/);
  });

  it("checks platform admin server-side, whoever calls it", () => {
    const body = platformFns.slice(platformFns.indexOf("export const startImpersonation"));
    expect(body.slice(0, 600)).toMatch(/await assertPlatformAdmin\(context\.supabase, context\.userId\)/);
  });

  it("still has its original caller on the tenant page", () => {
    // This is an added caller, not a moved one.
    expect(detailRoute).toMatch(/launchImpersonationTab\(impersonateFn as never/);
  });
});

describe("the users directory can impersonate the person it found", () => {
  it("calls the same server function through the same shared launcher", () => {
    expect(usersRoute).toMatch(/import \{ startImpersonation \} from "@\/lib\/platform\.functions"/);
    expect(usersRoute).toMatch(/launchImpersonationTab\(impersonateFn as never/);
    // Not a hand-rolled window.open: the tab-scoped session handling is the
    // part that keeps the admin's own session out of it.
    expect(usersRoute).not.toMatch(/window\.open\(/);
  });

  it("asks which organization when the user is in more than one", () => {
    expect(usersRoute).toMatch(/id="impersonate-org"/);
    expect(usersRoute).toMatch(/d\.organizations\.map\(\(o\) => \(/);
    expect(usersRoute).toMatch(/impersonateOrg \|\| d\.organizations\[0\]\.id/);
  });

  it("offers nothing when the user belongs to no organization", () => {
    // There is no grant to mint, and the picker would be empty.
    expect(usersRoute).toMatch(/d\.organizations\.length > 0 \? \(/);
  });

  it("confirms by naming the person and the business, not a generic prompt", () => {
    expect(usersRoute).toMatch(
      /title: `Impersonate \$\{d\.email \?\? "this user"\} in \$\{org\?\.name \?\? "their organization"\}\?`/,
    );
    expect(usersRoute).toMatch(/written to the audit trail/);
    expect(usersRoute).not.toMatch(/Are you sure/i);
  });

  it("says what happened, naming the person and the business", () => {
    expect(usersRoute).toMatch(/Impersonating \$\{res\.targetEmail\} in \$\{org\?\.name/);
  });

  it("surfaces a failure instead of swallowing it", () => {
    const block = usersRoute.slice(usersRoute.indexOf("const impersonate = useMutation"));
    expect(block.slice(0, 900)).toMatch(/onError: \(e: Error\) => toast\.error\(e\.message\)/);
  });

  it("forgets the chosen organization when the dialog closes", () => {
    // The dialog is reused for the next user clicked; a stale org id here
    // would aim the next impersonation at the previous person's tenant.
    const close = usersRoute.slice(usersRoute.indexOf("const close = () =>"));
    expect(close.slice(0, 300)).toMatch(/setImpersonateOrg\(""\)/);
  });
});
