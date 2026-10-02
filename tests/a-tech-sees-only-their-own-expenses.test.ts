// A tech sees only their own expenses, and receipts live in a bucket the
// migration makes.
//
// Two halves, as a-quote-is-answered-once.test.ts does it:
//
//   * The migration's TEXT, read here, for the shape of the thing: one
//     permissive policy per command, each asking the office permission OR the
//     caller's own staff row; no anon grant; the bucket created by the file
//     rather than at a console; four storage policies through one helper that
//     reads the first folder as the org.
//
//   * A real Postgres, for whether it HOLDS. Text can describe a policy that
//     a later grant undoes, or a helper that answers true for everyone, and
//     still match every regex. So this runs
//     tests/sql/nobody-knew-what-a-route-cost.proof.sql against the local
//     stack: it applies the migration inside a transaction, builds two tenants
//     with two techs, a dispatcher and an owner, and proves as each of them
//     (and as anon) who reads and writes what -- expenses and receipt objects
//     both -- then ROLLS BACK, the migration included.
//
// When no database is reachable (CI's unit job, a laptop without Docker) the
// second half says so loudly and skips. "The experiment says the leak is
// closed" and "no experiment was run" must not read the same.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mileageAmountCents } from "@/lib/expenses";

const ROOT = join(import.meta.dirname, "..");
const DB_URL =
  process.env.EXPENSES_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260929090000_nobody-knew-what-a-route-cost.sql",
);
const PROOF = join(ROOT, "tests/sql/nobody-knew-what-a-route-cost.proof.sql");
const SQL = readFileSync(MIGRATION, "utf8");

/** One statement, from its first word to its semicolon. */
function statement(startsWith: RegExp): string {
  const m = startsWith.exec(SQL);
  if (!m) return "";
  return SQL.slice(m.index, SQL.indexOf(";", m.index) + 1);
}

describe("the migration, as written", () => {
  it("turns RLS on and gives anon nothing", () => {
    expect(SQL).toMatch(/ALTER TABLE public\.expenses ENABLE ROW LEVEL SECURITY;/);
    expect(SQL).toMatch(/REVOKE ALL ON public\.expenses FROM anon;/);
    expect(SQL).not.toMatch(/GRANT [^;]*ON public\.expenses TO [^;]*\banon\b/);
  });

  it("has one policy per command, each for authenticated, each office-or-own", () => {
    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const policies = [
        ...SQL.matchAll(
          new RegExp(
            `CREATE POLICY "[^"]+" ON public\\.expenses\\s+FOR ${cmd} TO authenticated`,
            "g",
          ),
        ),
      ];
      expect(policies, `${cmd} policies`).toHaveLength(1);
      const body = SQL.slice(policies[0].index!, SQL.indexOf(";", policies[0].index!));
      // The office: the money permission, asked once per statement.
      expect(body).toMatch(
        /public\.has_permission\(\(SELECT auth\.uid\(\)\), organization_id, 'view_financials'\)/,
      );
      // Anybody else: only a row filed against their own staff row.
      expect(body).toMatch(/OR public\.is_own_staff_row\(staff_id, organization_id\)/);
      // Never bare membership, which every tech has.
      expect(body).not.toMatch(/is_org_member/);
    }
  });

  it("checks the row a tech would write, not only the row they found", () => {
    const update = statement(/CREATE POLICY "[^"]+" ON public\.expenses\s+FOR UPDATE/);
    expect(update).toMatch(/USING \(/);
    expect(update).toMatch(/WITH CHECK \(/);
  });

  it("asks is_own_staff_row about the caller only, and only a current member", () => {
    const fn = statement(/CREATE OR REPLACE FUNCTION public\.is_own_staff_row/);
    // Two semicolons in the body; take through $function$.
    const body = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.is_own_staff_row"));
    const def = body.slice(0, body.indexOf("$function$;") + 11);
    expect(fn).toMatch(/\(_staff_id uuid, _org_id uuid\)/);
    expect(def).toMatch(/s\.user_id = auth\.uid\(\)/);
    expect(def).toMatch(/AND s\.active/);
    expect(def).toMatch(/JOIN public\.user_roles ur/);
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.is_own_staff_row\(uuid, uuid\) FROM PUBLIC, anon;/,
    );
  });

  it("indexes every foreign key", () => {
    expect(SQL).toMatch(/ON public\.expenses \(organization_id, spent_on\)/);
    expect(SQL).toMatch(/ON public\.expenses \(staff_id, spent_on\)/);
    expect(SQL).toMatch(/ON public\.expenses \(created_by\)/);
  });
});

describe("the receipts bucket, as written", () => {
  it("is created by the migration, private, and leaves production's alone", () => {
    expect(SQL).toMatch(
      /INSERT INTO storage\.buckets \(id, name, public, file_size_limit, allowed_mime_types\)\s+VALUES \(\s*'expense-receipts', 'expense-receipts', false,/,
    );
    expect(SQL).toMatch(/ON CONFLICT \(id\) DO NOTHING;/);
  });

  it("has all four commands, UPDATE included, because the replay uploads with upsert", () => {
    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const p = statement(
        new RegExp(
          `CREATE POLICY "expense receipts: [^"]+"\\s+ON storage\\.objects FOR ${cmd} TO authenticated`,
        ),
      );
      expect(p, `${cmd} storage policy`).not.toBe("");
      expect(p).toMatch(
        /bucket_id = 'expense-receipts' AND public\.can_use_expense_receipt\(name, (true|false)\)/,
      );
    }
    // Only reading may reach the "receipt on my expense" branch.
    expect(statement(/CREATE POLICY "expense receipts: office and owner read"/)).toMatch(
      /can_use_expense_receipt\(name, false\)/,
    );
  });

  it("reads the first folder as the org, the way the visit-photos policies do, but checks it first", () => {
    const at = SQL.indexOf("CREATE OR REPLACE FUNCTION public.can_use_expense_receipt");
    const def = SQL.slice(at, SQL.indexOf("$function$;", at));
    expect(def).toMatch(/_folders text\[\] := storage\.foldername\(_name\);/);
    expect(def).toMatch(/_folders\[1\] !~\* '\^\[0-9a-f\]\{8\}-/);
    expect(def).toMatch(/_org := _folders\[1\]::uuid;/);
    expect(def).toMatch(/public\.has_permission\(_uid, _org, 'view_financials'\)/);
    expect(def).toMatch(/s\.id::text = _folders\[2\]/);
  });
});

// ── The real database ──────────────────────────────────────────────────────

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
    `\n  SKIPPED: the expense proofs did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set EXPENSES_PROOF_DB_URL to run them.\n",
  );
}

describe.skipIf(!reachable)("the expense rules hold in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("proves every rule, and leaves nothing behind", () => {
    const r = spawnSync(psql!, [DB_URL, "-X", "-v", `migration=${MIGRATION}`, "-f", PROOF], {
      encoding: "utf8",
      timeout: 300_000,
    });
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    // Eight groups of checks, each announcing itself only when it passed.
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(8);
    expect(out).toMatch(/ALL EXPENSE PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [
        DB_URL,
        "-XAtc",
        "select count(*) from public.organizations where name like 'Expense Proof %'",
      ],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });

  it("rounds a mileage trip to the same cent in Postgres as in the browser", () => {
    // The trigger's round(numeric(7,1) * numeric(6,2)) against the form's
    // preview, on the cases floating point gets wrong.
    const cases: Array<[number, number]> = [
      [64.6, 62.5],
      [128.2, 62.5],
      [12.3, 72.5],
      [23.4, 72.5],
      [0.1, 72.5],
      [99999.9, 999.99],
    ];
    const values = cases.map(([m, r], i) => `(${i}, ${m}::numeric(7,1), ${r}::numeric(6,2))`);
    const sql = `select round(m * r)::bigint from (values ${values.join(", ")}) v(i, m, r) order by i`;
    const res = spawnSync(psql!, [DB_URL, "-XAtc", sql], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    const db = res.stdout.trim().split("\n").map(Number);
    expect(db).toEqual(cases.map(([m, r]) => mileageAmountCents(m, r)));
  });
});
