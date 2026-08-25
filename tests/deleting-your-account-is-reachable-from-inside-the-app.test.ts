// App Review guideline 5.1.1(v): an app that supports account CREATION must
// let a person delete their account from inside the app.
//
// HoundStack supports creation and ships it in the binary — an unrecognised
// email at sign-in navigates to /get-started, and `get-started-*.js` is in
// ios/App/App/public/assets/. Until this landed, the app's only answer was the
// sentence the guideline exists to reject, and it was written down in
// legal.privacy.tsx: "you can request deletion ... by emailing support".
//
// ── WHAT THESE PIN, AND WHAT THEY DELIBERATELY DO NOT ─────────────────────
//
// The BEHAVIOUR — sole-owner refusal, transfer, workspace close, records
// preserved, home coordinates cleared — is proven against a replayed database
// in supabase/proofs/20260825210000-account-deletion.sql, because it is SQL and
// only a database can answer it honestly.
//
// What is left for a source test is the half a database cannot see: that the
// control is REACHABLE, that it is not gated out of the native build, that the
// copy tells the truth about retention, and that the server function ends the
// session rather than only the membership.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const card = read("src/components/DeleteAccountCard.tsx");
const profile = read("src/routes/_authenticated/profile.tsx");
const server = read("src/lib/delete-account.functions.ts");
const sql = read(
  "supabase/migrations/20260825210000_a-person-could-not-delete-their-own-account.sql",
);

describe("a person can delete their account from inside the app", () => {
  it("the entry point is on the account page, not buried in settings", () => {
    expect(profile).toMatch(/<DeleteAccountCard\s*\/>/);
    expect(profile).toMatch(/from "@\/components\/DeleteAccountCard"/);
  });

  it("is NOT gated out of the native bundle", () => {
    // The whole point of the guideline is the binary. A well-meaning
    // `!IS_NATIVE_BUNDLE` here — the same shape that correctly hides the SaaS
    // purchase UI — would remove the one control App Review is looking for.
    expect(card).not.toMatch(/IS_NATIVE_BUNDLE/);
    const profileCardRegion = profile.slice(profile.indexOf("<DeleteAccountCard"));
    expect(profileCardRegion.slice(0, 200)).not.toMatch(/IS_NATIVE_BUNDLE/);
  });

  it("says both true things: access ends, business records may be retained", () => {
    // Whitespace-collapsed before matching: Prettier reflows JSX copy across
    // line breaks, and a test that pins the line wrapping fails on formatting
    // rather than on meaning. The words are the contract; the columns are not.
    const flat = card.replace(/\s+/g, " ");
    expect(flat).toMatch(/removes your sign-in and access/i);
    expect(flat).toMatch(/invoices, payments, service history, and audit logs/i);
    expect(flat).toMatch(/retained where required/i);
  });

  it("tells a sole owner what to do instead of only refusing", () => {
    expect(card.replace(/\s+/g, " ")).toMatch(/transfer ownership or close the workspace/i);
    expect(sql).toMatch(/only owner of this workspace/);
  });

  it("ends the session, not just the membership", () => {
    // Removing user_roles stops org-scoped reads. It does not invalidate a
    // token already on a phone, and a deleted account that can still make
    // authenticated requests is not deleted.
    expect(server).toMatch(/auth\.admin\.signOut\(/);
    expect(server).toMatch(/"global"/);
  });

  it("anonymises the identity to an address that can never receive mail", () => {
    expect(server).toMatch(/deleted-\$\{userId\}@deleted\.invalid/);
    expect(server).toMatch(/auth\.admin\.updateUserById\(/);
  });

  it("never deletes financial or service records", () => {
    // The migration asserts this of itself at replay time; this is the
    // static half, so a future edit is caught before a database is involved.
    expect(sql).not.toMatch(/DELETE\s+FROM\s+public\.(invoices|payments|visits|credit_ledger)/i);
    expect(sql).toMatch(/DELETE FROM public\.user_roles/);
  });

  it("clears the personal columns that actually hold personal data", () => {
    // staff carries a technician's home address and its coordinates. Leaving
    // those behind would make "deleted" untrue in the way that matters most.
    for (const col of [
      "display_name",
      "email",
      "phone",
      "avatar_url",
      "start_address",
      "start_latitude",
      "end_latitude",
    ]) {
      expect(sql, `${col} is not cleared on deletion`).toMatch(new RegExp(col));
    }
  });

  it("requires authentication, and cannot be called for somebody else", () => {
    expect(server).toMatch(/requireSupabaseAuth/);
    // The SQL takes its subject from auth.uid(), never from an argument, so
    // there is no user id a caller could substitute.
    expect(sql).toMatch(/_uid uuid := auth\.uid\(\)/);
    expect(server).not.toMatch(/userId:\s*z\.string/);
  });

  it("the privacy page no longer says email support is the only route", () => {
    const privacy = read("src/routes/legal.privacy.tsx");
    const emailOnly = /request deletion of your account[^.]*by emailing/i.test(privacy);
    expect(
      emailOnly,
      "legal.privacy.tsx still tells people to email support to delete their account, " +
        "which is the exact text guideline 5.1.1(v) rejects",
    ).toBe(false);
  });
});

describe("and it reaches the shipped iOS bundle", () => {
  const assets = join(root, "ios/App/App/public/assets");

  it("the built native bundle contains the delete-account control", () => {
    if (!existsSync(assets)) {
      // Not built in this checkout. Say so rather than passing quietly — a
      // green assertion over a directory that does not exist is the failure
      // mode this repo has been bitten by twice today.
      console.warn("ios/App/App/public/assets missing — native bundle check skipped");
      return;
    }
    const hit = readdirSync(assets)
      .filter((f) => f.endsWith(".js"))
      .some((f) => readFileSync(join(assets, f), "utf8").includes("removes your sign-in and access"));
    expect(hit, "the delete-account copy is not in the built native bundle").toBe(true);
  });
});
