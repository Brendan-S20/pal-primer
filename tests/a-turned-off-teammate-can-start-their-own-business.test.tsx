// A turned-off teammate can start their own business with the same email (#765).
//
// #782 let a teammate whose membership was GONE back in. Tester's retest on
// 3a028504 found the other half: Deactivate, the only removal Settings ->
// Users offers, keeps the membership, so the address landed on /access-off
// with only Check again and Sign out, and Get started could never give it a
// business of its own.
//
// Three halves:
//   * the SQL proof (tests/sql/a-turned-off-teammate-can-start-their-own-business.proof.sql)
//     runs when a local stack answers: remove a member, leave, sign up fresh,
//     land in a new workspace, the old business untouched;
//   * the migration is pinned so a later redefinition cannot widen it;
//   * the screen is rendered: the way out is there, in the phone's language,
//     behind a second tap, and the route sends the person to /no-workspace.

import { describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n from "@/lib/i18n";
import { AccessOffCard } from "@/components/AccessOffCard";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";

vi.setConfig({ testTimeout: 300_000 });

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20261111060000_a-turned-off-teammate-can-leave-and-start-their-own-business.sql",
);
const PROOF = join(ROOT, "tests/sql/a-turned-off-teammate-can-start-their-own-business.proof.sql");

/** The newest migration that (re)defines the leave function, and its body. */
function newest() {
  const re = /CREATE OR REPLACE FUNCTION public\.leave_business_i_was_turned_off_in/i;
  const files = migrationFiles().filter((f) => re.test(readMigration(f)));
  const file = files[files.length - 1];
  const sql = stripLineComments(readMigration(file));
  const at = sql.search(re);
  return { file, body: sql.slice(at, sql.indexOf("$function$;", at)) };
}

describe("leave_business_i_was_turned_off_in", () => {
  it("acts only for the caller, and takes no argument naming anybody else", () => {
    const { file, body } = newest();
    expect(body, file).toMatch(/leave_business_i_was_turned_off_in\(\)\s*RETURNS uuid/);
    expect(body, file).toMatch(/_uid uuid := auth\.uid\(\)/);
    expect(body, file).toMatch(
      /DELETE FROM public\.user_roles WHERE user_id = _uid AND organization_id = _org/,
    );
  });

  it("refuses a person who is on, and one who has not finished two-step sign-in", () => {
    const { file, body } = newest();
    expect(body, file).toMatch(/s\.user_id = _uid AND NOT s\.active/);
    expect(body, file).toMatch(
      /NOT EXISTS \(SELECT 1 FROM public\.staff s[\s\S]*?s\.user_id = _uid AND s\.active\)/,
    );
    expect(body, file).toMatch(/IF NOT public\.mfa_satisfied\(\) THEN/);
  });

  it("keeps the staff row and its history, never touches auth.users, and tells the business", () => {
    const { file, body } = newest();
    expect(body, file).not.toMatch(/DELETE\s+FROM\s+public\.staff/i);
    expect(body, file).not.toMatch(/auth\.users/i);
    expect(body, file).toMatch(/'staff\.left'/);
  });

  it("is not callable signed out", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.leave_business_i_was_turned_off_in\(\) FROM PUBLIC, anon;/,
    );
  });
});

describe("the way out on /access-off", () => {
  function render(lang: string) {
    const t = i18n.cloneInstance({ lng: lang });
    return renderToStaticMarkup(
      <I18nextProvider i18n={t}>
        <AccessOffCard
          state={{ kind: "off", business: "Acme Scoop", checkedAgain: false }}
          onCheckAgain={() => {}}
          onSignOut={() => {}}
          onStartOwn={async () => {}}
        />
      </I18nextProvider>,
    );
  }

  it("offers Start my own business beside Check again and Sign out", () => {
    const html = render("en");
    expect(html).toContain("Start my own business");
    expect(html).toContain("Check again");
    expect(html).toContain("Sign out");
    // The confirmation is a second tap, not drawn until asked for.
    expect(html).not.toContain("Leave and start my own");
  });

  it("speaks the phone's language", () => {
    expect(render("es")).toContain("Crear mi propio negocio");
    expect(render("ar")).toContain("ابدأ عملي الخاص");
    expect(render("zh")).toContain("创建我自己的商家");
  });

  it("is not drawn when the page offers no way out", () => {
    const t = i18n.cloneInstance({ lng: "en" });
    const html = renderToStaticMarkup(
      <I18nextProvider i18n={t}>
        <AccessOffCard
          state={{ kind: "off", business: null, checkedAgain: false }}
          onCheckAgain={() => {}}
          onSignOut={() => {}}
        />
      </I18nextProvider>,
    );
    expect(html).not.toContain("Start my own business");
  });

  it("the route leaves, forgets the cached 'off', and goes to /no-workspace", () => {
    const src = readFileSync(join(ROOT, "src/routes/access-off.tsx"), "utf8");
    const start = src.slice(src.indexOf("const startOwn"), src.indexOf("const signOut"));
    expect(start).toMatch(/await leaveBusinessIWasTurnedOffIn\(\)/);
    expect(start).toMatch(/removeQueries\(\{ queryKey: \["my-org"\] \}\)/);
    expect(start).toMatch(/navigate\(\{ to: "\/no-workspace"/);
    expect(src).toMatch(/onStartOwn=\{startOwn\}/);
  });

  it("sign-in tells a taken address it can start its own business once in", () => {
    const src = readFileSync(join(ROOT, "src/routes/auth.tsx"), "utf8");
    expect(src).toContain("Once you're in, you can start your own business with it.");
  });
});

const DB_URL =
  process.env.WEBHOOKS_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the turned-off-teammate proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set WEBHOOKS_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("a removed member signs up fresh, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("remove a member, then the same email signs up fresh and lands in a new workspace, and neither business can read the other", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(8);
    expect(out).toMatch(/ALL TURNED-OFF-TEAMMATE PROOFS PASSED/);
  });
});
