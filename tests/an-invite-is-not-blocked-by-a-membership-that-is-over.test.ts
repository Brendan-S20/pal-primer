// An invited technician is not blocked by a membership that is over (#982).
//
// Pins 20261118030000: it redefines accept_org_invite_for_current_user, keeps
// the refusal message and every other branch of 20261109180000, and counts a
// membership only when its business is live and the person is not turned off
// there. Runs tests/sql/an-invite-is-not-blocked-by-a-membership-that-is-over.proof.sql
// against a real database when one answers (skipped, loudly, when none does):
// it reproduces the bug on the old function first, then proves the fix.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// A proof waits its turn behind others (tests/the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(__dirname, "..");
const NAME = "an-invite-is-not-blocked-by-a-membership-that-is-over";
const VERSION = "20261118030000";
const MIGRATION = join(ROOT, `supabase/migrations/${VERSION}_${NAME}.sql`);
const PREVIOUS = join(ROOT, "supabase/migrations/20261109180000_a-removed-teammate-can-be-invited-back.sql");
const PROOF = join(ROOT, "tests/sql/an-invite-is-not-blocked-by-a-membership-that-is-over.proof.sql");

const fnBody = (sql: string) => sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.accept_org_invite_for_current_user"));

describe("the dead-membership migration, as a file", () => {
  const sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";

  it("has its migration, rollback, proof and CI wrapper", () => {
    for (const f of [
      MIGRATION,
      join(ROOT, `supabase/rollback/${VERSION}_${NAME}.down.sql`),
      PROOF,
      join(ROOT, `supabase/proofs/${VERSION}-${NAME}.sql`),
    ]) {
      expect(existsSync(f), f).toBe(true);
    }
  });

  it("holds its version alone", () => {
    const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith(VERSION))).toEqual([`${VERSION}_${NAME}.sql`]);
  });

  it("keeps the refusal, the token and email paths and the splice text of 20261109180000", () => {
    const now = fnBody(sql);
    const before = fnBody(readFileSync(PREVIOUS, "utf8"));
    for (const keep of [
      "This account already belongs to another organization. Ask the inviter to send the invitation to a different email address, or leave your current organization first.",
      "This email has a pending invitation. Open the link in that invitation email to join.",
      "platform_admin cannot be granted by an organization invitation.",
      "--   was: split_part(_email, '@', 1), true);",
      "AND lower(email) = lower(_email)",
    ]) {
      expect(before).toContain(keep);
      expect(now).toContain(keep);
    }
  });

  it("counts only a live business where the person is not turned off", () => {
    const guard = fnBody(sql).split("-- BUG-18")[1].split("IF _existing_org IS NOT NULL")[0];
    expect(guard).toMatch(/o\.deleted_at IS NULL/);
    expect(guard).toMatch(/NOT s\.active/);
    expect(guard).toMatch(/AND s\.active/);
  });

  it("retires the dead memberships before the new one, and never writes to a deleted business", () => {
    const body = fnBody(sql);
    expect(body.indexOf("DELETE FROM public.user_roles ur")).toBeGreaterThan(0);
    expect(body.indexOf("DELETE FROM public.user_roles ur")).toBeLessThan(
      body.indexOf("INSERT INTO public.user_roles(user_id, organization_id, role)"),
    );
    expect(body).toMatch(/o\.deleted_at IS NULL\);\n\s+END LOOP/);
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of ["psql", "/opt/homebrew/opt/libpq/bin/psql", "/opt/homebrew/opt/postgresql@17/bin/psql"]) {
    if (spawnSync(p, ["--version"], { encoding: "utf8" }).status === 0) return p;
  }
  return null;
}
const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], { encoding: "utf8", timeout: 5_000 }).stdout?.trim() === "1";
if (!reachable) {
  console.warn(`\n  SKIPPED: the ${NAME} proof did NOT run (no database at ${DB_URL}).\n`);
}

describe.skipIf(!reachable)("the dead-membership migration, in a real database", () => {
  it("reproduces the refusal on the old function, then joins a turned-off and a deleted-business member, and still refuses a real member", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-f", PROOF], { encoding: "utf8", timeout: 300_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED|PROOF INCONCLUSIVE/);
    expect(out).toMatch(/ALL DEAD-MEMBERSHIP INVITE PROOFS PASSED/);
  });
});
