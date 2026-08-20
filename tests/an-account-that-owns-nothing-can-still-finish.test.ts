import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Source with comments blanked out, same length so offsets still line up.
 *  The first version of the ordering test below indexed the raw file and
 *  passed against a deliberately mis-ordered helper: the doc comment at the
 *  top NAMES accept_org_invite_for_current_user, so indexOf found the prose
 *  describing the rule rather than the call obeying it. A test that reads the
 *  comment explaining the invariant will never notice the invariant break. */
export function codeOnly(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    if (src.startsWith("/*", i)) {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      out += src.slice(i, stop).replace(/[^\n]/g, " ");
      i = stop;
    } else if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i);
      const stop = nl === -1 ? src.length : nl;
      out += " ".repeat(stop - i);
      i = stop;
    } else {
      out += src[i];
      i += 1;
    }
  }
  return out;
}

const HELPER = "src/lib/ensure-workspace.ts";
const AUTH = "src/routes/auth.tsx";
const NO_WORKSPACE = "src/routes/no-workspace.tsx";

// Signup is two calls with no transaction around them: registerAccount creates
// the auth user, bootstrapOrganization creates the org. A failure between them
// leaves an account that owns nothing, and /get-started refuses a second
// registration for the same email — so the account cannot retry. Nine such
// accounts exist in production; one of them belongs to a real business.
//
// /no-workspace is where those accounts land, and it now offers to finish the
// job. What makes that safe is not the button, it is the ORDER inside
// ensureBootstrapped, and the order is invisible at the call site. These tests
// pin the two properties a future edit is most likely to break silently.
describe("finishing a signup that stopped halfway", () => {
  it("claims a pending invite before it creates any organization", () => {
    const src = codeOnly(read(HELPER));
    const invite = src.indexOf("accept_org_invite_for_current_user");
    const bootstrap = src.indexOf("bootstrapOrganization({");
    expect(invite, `${HELPER} no longer accepts invites`).toBeGreaterThan(-1);
    expect(bootstrap, `${HELPER} no longer bootstraps an org`).toBeGreaterThan(-1);
    // Not cosmetic. accept_org_invite_for_current_user REFUSES an invite that
    // would be a second membership (BUG-18), and the refusal is permanent: an
    // invited account that creates its own org can never join the workspace it
    // was invited to. Bootstrapping first turns a recoverable state into an
    // unrecoverable one, and it does so silently.
    expect(
      invite,
      `${HELPER} must accept a pending invite BEFORE bootstrapping an org — ` +
        "bootstrapping first permanently blocks the invite (BUG-18).",
    ).toBeLessThan(bootstrap);
  });

  it("is one implementation, not two copies that can drift apart", () => {
    // /auth had the only copy, and it ran on exactly one trigger: a visit to
    // /auth. A second hand-written copy on /no-workspace would be the obvious
    // way to add the recovery, and would put the BUG-18 ordering in two places.
    for (const route of [AUTH, NO_WORKSPACE]) {
      const src = codeOnly(read(route));
      expect(src, `${route} should call the shared helper`).toContain(
        'from "@/lib/ensure-workspace"',
      );
      expect(
        src.includes("accept_org_invite_for_current_user"),
        `${route} re-implements the invite/bootstrap sequence instead of calling ` +
          "ensureBootstrapped — there must be exactly one copy of that ordering.",
      ).toBe(false);
    }
  });

  it("does not offer a workspace to a platform admin", () => {
    // Platform admins hold zero user_roles rows by design. bootstrap_organization
    // returns NULL for them server-side, so the form would fail confusingly
    // rather than dangerously — but it should not be shown at all.
    expect(codeOnly(read(NO_WORKSPACE))).toContain("{!isPlatformAdmin && (");
  });

  it("still has a way out for an account that does not want to proceed", () => {
    // The page's original job. A recovery form that replaced sign-out would
    // strand a person who arrived here by someone else's mistake.
    expect(read(NO_WORKSPACE)).toContain("Sign out");
  });
});
