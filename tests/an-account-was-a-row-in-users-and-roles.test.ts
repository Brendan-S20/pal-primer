// There was nowhere to be a person in this product.
//
// Your name was whatever the person who invited you typed into Users & roles,
// and only an admin could change it — from a table of the whole company. Your
// email was fixed at signup with no path to change it at all. There was no
// photo anywhere: `src/components/ui/avatar.tsx` had been in the repo since
// the beginning and no file imported it. The only trace of the signed-in
// account anywhere in the shell was a bare "Sign out" button.
//
// These assertions cover the parts that are easy to get wrong later: the
// scoping that keeps "edit my profile" from becoming "edit anybody's", and
// the email flow telling the truth about when it has and has not taken effect.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * These files explain their design by naming the thing they deliberately do
 * NOT do, so a bare `not.toMatch` matches the comment that documents the
 * decision. Negative assertions run against the file with comment lines
 * stripped; crude on purpose, it only has to stop prose impersonating code.
 */
const codeOnly = (src: string) =>
  src
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("--") || t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

const fns = read("src/lib/profile.functions.ts");
const page = read("src/routes/_authenticated/profile.tsx");
const avatar = read("src/components/UserAvatar.tsx");
const menu = read("src/components/AccountMenu.tsx");
const shell = read("src/routes/_authenticated/route.tsx");
const sidebar = read("src/components/AppSidebar.tsx");
const tabbar = read("src/components/MobileTabBar.tsx");
const migration = read(
  "supabase/migrations/20260805120000_an-account-was-a-row-in-users-and-roles.sql",
);

describe("every write is scoped to the caller", () => {
  it("no function takes a staff id", () => {
    // The moment one does, an admin screen reuses it and "edit my profile"
    // silently becomes "edit anybody's".
    expect(codeOnly(fns)).not.toMatch(/staffId/);
    expect(codeOnly(fns)).not.toMatch(/userId: z\.string\(\)/);
  });

  it("every staff write filters on the caller's own user_id", () => {
    const updates = fns.match(/\.from\("staff"\)\s*\n?\s*\.update\(/g) ?? [];
    expect(updates.length).toBeGreaterThanOrEqual(2);
    const scoped = fns.match(/\.eq\("user_id", userId\)/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(updates.length);
  });

  it("an avatar path is checked against the caller before it is stored", () => {
    // The storage policy already refuses the upload, but storing a path to
    // somebody else's file would break the moment its owner replaced theirs.
    expect(fns).toMatch(/orgSeg !== staff\.organization_id \|\| userSeg !== userId/);
    expect(fns).toMatch(/That file does not belong to your account/);
  });
});

describe("the email change does not claim to have happened", () => {
  it("goes through Auth, not the staff row", () => {
    // Writing staff.email alone would leave you signing in with the old
    // address forever, with a UI saying the change succeeded.
    expect(fns).toMatch(/supabase\.auth\.updateUser\(\{ email: data\.email \}\)/);
  });

  it("returns where the confirmation went, not a success", () => {
    expect(fns).toMatch(/return \{ sentTo: data\.email \}/);
    expect(page).toMatch(/Confirmation sent to \$\{r\.sentTo\}/);
    expect(page).toMatch(/takes effect once you click it/);
  });

  it("a confirmed change heals the staff row on the next load", () => {
    expect(fns).toMatch(/if \(staff && authEmail && staff\.email !== authEmail\)/);
  });

  it("a pending change is shown rather than left invisible", () => {
    expect(fns).toMatch(/pendingEmail:/);
    expect(page).toMatch(/is waiting on the confirmation link/);
  });

  it("passwords are reset by emailed link, not typed in place", () => {
    expect(fns).toMatch(/resetPasswordForEmail/);
    expect(page).toMatch(/somebody left unlocked cannot be used to change it/);
    expect(page).not.toMatch(/type="password"/);
  });
});

describe("avatars stay private", () => {
  it("the bucket is not public", () => {
    expect(migration).toMatch(/VALUES \('avatars', 'avatars', false\)/);
  });

  it("reads are org-scoped and writes are self-only", () => {
    expect(migration).toMatch(/org members read avatars[\s\S]{0,240}is_org_member/);
    expect(migration).toMatch(
      /people upload their own avatar[\s\S]{0,400}\(storage\.foldername\(name\)\)\[2\] = auth\.uid\(\)::text/,
    );
    expect(migration).toMatch(/people delete their own avatar/);
  });

  it("upload also checks the org, not just the user id", () => {
    // Without it, a member of org A could write into org B's folder under
    // their own user id, and org B would then serve a file A controls.
    const insert = migration.slice(migration.indexOf("people upload their own avatar"));
    expect(insert).toMatch(/is_org_member\(auth\.uid\(\)[\s\S]{0,80}\[1\]/);
  });

  it("the path is read through a signed URL, never used as one", () => {
    expect(avatar).toMatch(/useSignedUrl\("avatars"/);
    // Named avatar_url for consistency with organizations.logo_url, which also
    // holds a path. The column comment is where that trap is disarmed.
    expect(migration).toMatch(/Not a\s*'\s*'URL despite the name/);
    expect(page).not.toMatch(/src=\{staff\.avatar_url\}/);
  });
});

describe("people without a photo are still distinguishable", () => {
  it("the fallback is initials on a stable colour, not a grey disc", () => {
    // On day one nobody has a photo. A column of identical grey circles is
    // worse than no avatar at all on a board where colour is how you read it.
    expect(avatar).toMatch(/export function initialsOf/);
    expect(avatar).toMatch(/export function toneOf/);
    expect(avatar).toMatch(/h = \(h \* 31 \+ seed\.charCodeAt\(i\)\) >>> 0/);
  });

  it("initials handle one name and no name", () => {
    expect(avatar).toMatch(/if \(parts\.length === 0\) return "\?"/);
    expect(avatar).toMatch(/if \(parts\.length === 1\)/);
  });
});

describe("the account is reachable from everywhere it should be", () => {
  it("the header avatar replaced the bare Sign out button", () => {
    expect(shell).toMatch(/<AccountMenu onSignOut=\{handleSignOut\} \/>/);
    expect(shell).not.toMatch(
      /onClick=\{handleSignOut\} className="max-md:hidden">\s*\n?\s*Sign out/,
    );
  });

  it("sign out moved one level in, and stays destructive", () => {
    expect(menu).toMatch(/className="cursor-pointer text-destructive"/);
  });

  it("the menu answers which account you are in", () => {
    expect(menu).toMatch(/\{authEmail\}/);
  });

  it("the sidebar has a footer identifying you", () => {
    expect(sidebar).toMatch(/<SidebarFooter>/);
    expect(sidebar).toMatch(/to="\/profile"/);
  });

  it("the phone's More sheet leads with you", () => {
    // On a phone this sheet is the only place the identity appears at all —
    // the header is hidden on My Day.
    const profileIdx = tabbar.indexOf('to="/profile"');
    const navIdx = tabbar.indexOf('aria-label={t("nav.allSections")}');
    expect(navIdx).toBeGreaterThan(-1);
    expect(profileIdx).toBeGreaterThan(-1);
    expect(profileIdx).toBeLessThan(navIdx);
  });
});

describe("what the page will not pretend you control", () => {
  it("role and route eligibility are shown read-only", () => {
    // They are decisions an employer makes about you. Offering them as
    // editable would be offering something the server refuses.
    expect(page).toMatch(/Set by an owner or office manager/);
    expect(fns).not.toMatch(/role:/);
    expect(fns).not.toMatch(/is_field_tech:/);
  });

  it("rejects image formats a browser will not paint", () => {
    // A HEIC straight off an iPhone would upload fine and render as a broken
    // image — the failure would look like the feature not working.
    expect(page).toMatch(/const ACCEPT = "image\/png,image\/jpeg,image\/webp"/);
  });
});
