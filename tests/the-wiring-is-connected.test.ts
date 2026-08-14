import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A QA pass mutation-tested this repo's gates and switched eight protections
// off with the full suite still at 752 passed. Every one of them was a guard
// that EXISTS being checked, while nothing checked it was CONNECTED:
//
//   * CSRF could be removed from requestMiddleware — nine of the ten csrf tests
//     drive a local copy of the options declared inside the test file, and the
//     tenth was a whole-file toContain satisfied by the import line.
//   * A cron endpoint could stop enforcing its own auth result.
//   * OAuth tokens could go back to plaintext at the write site.
//   * tg_orgs_protect_platform_columns could be detached from `organizations`,
//     leaving its body — which is all the test read — untouched.
//   * RLS could be disabled outright on payments and
//     franchise_royalty_invoices, invisible to policy-text scans.
//
// This file only asserts wiring. It deliberately does not re-check what the
// guards DO — those tests exist and hold up; what was missing is that they are
// plugged in.

const ROOT = new URL("..", import.meta.url).pathname;
const MIGRATIONS = join(ROOT, "supabase", "migrations");

const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** Comments are not code. A guard named only in a comment protects nothing —
 *  the dead-machinery detector already made this exact mistake once by counting
 *  TypeScript comments as callers. */
function withoutComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("CSRF is registered, not merely defined", () => {
  const src = withoutComments(read("src/start.ts"));

  it("puts the csrf middleware in requestMiddleware", () => {
    // Deleting `csrfMiddleware` from this array leaves the app with no CSRF
    // protection at all and left every existing test green.
    const arr = /requestMiddleware:\s*\[([^\]]*)\]/.exec(src)?.[1];
    expect(arr, "no requestMiddleware array in start.ts").toBeTruthy();
    expect(arr!).toMatch(/\bcsrfMiddleware\b/);
    expect(arr!).toMatch(/\bcorsMiddleware\b/);
  });

  it("builds that middleware from createCsrfMiddleware", () => {
    // Guards against the array entry surviving while the const it names is
    // reassigned to something inert.
    expect(src).toMatch(/const\s+csrfMiddleware\s*=\s*createCsrfMiddleware\(/);
  });

  it("orders CORS ahead of CSRF", () => {
    // A preflight has no cookies and no Origin the CSRF check would accept, so
    // CORS has to answer it first or every cross-origin call from the native
    // app fails before it starts.
    const arr = /requestMiddleware:\s*\[([^\]]*)\]/.exec(src)![1];
    expect(arr.indexOf("corsMiddleware")).toBeLessThan(arr.indexOf("csrfMiddleware"));
  });
});

describe("every cron endpoint enforces the auth it computes", () => {
  const ROUTES = ["nightly", "announcement-emails", "weekly-digest"] as const;

  for (const route of ROUTES) {
    it(`${route} refuses an unauthorized request`, () => {
      const path = `src/routes/api/public/hooks/${route}.ts`;
      let src: string;
      try {
        src = withoutComments(read(path));
      } catch {
        // A renamed or deleted cron route should fail loudly here rather than
        // silently reducing coverage.
        throw new Error(`${path} is missing — update this list deliberately`);
      }
      // Computing `auth` and then not acting on it is the mutation that passed:
      // the nightly run charges autopay and generates invoices.
      expect(src, `${route} never calls authorizeCronRequest`).toMatch(/authorizeCronRequest\(/);
      expect(src, `${route} computes auth but does not enforce it`).toMatch(
        /if\s*\(\s*!\s*auth\.ok\s*\)\s*return\s+cronUnauthorized\(/,
      );
    });
  }
});

describe("credentials are encrypted at every write site", () => {
  // Targeting the TABLE rather than the field name. My first version matched
  // `access_token:` anywhere and flagged a zod schema and a variable being read
  // out of an OAuth response — neither is a write. A check that cries wolf gets
  // muted, which is how a real one stops being read.
  const CREDENTIAL_TABLES = ["accounting_connections", "org_twilio_credentials"];

  it("finds the credential writes at all", () => {
    const found = credentialWrites();
    expect(found.length, "no credential writes located — the scan is broken").toBeGreaterThan(0);
  });

  function credentialWrites(): Array<{ file: string; payload: string }> {
    const out: Array<{ file: string; payload: string }> = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          walk(p);
          continue;
        }
        if (!/\.ts$/.test(e.name)) continue;
        const text = withoutComments(readFileSync(p, "utf8"));
        for (const table of CREDENTIAL_TABLES) {
          const from = new RegExp(`\\.from\\(\\s*["']${table}["']\\s*\\)`, "g");
          for (const m of text.matchAll(from)) {
            const chain = text.slice(m.index! + m[0].length, m.index! + m[0].length + 800);
            const write = /\.(update|upsert|insert)\(\s*(\{[\s\S]*?\n\s*\})/.exec(chain);
            if (write) out.push({ file: p.replace(ROOT, ""), payload: write[2] });
          }
        }
      }
    };
    walk(join(ROOT, "src"));
    return out;
  }

  it("no token reaches one of those tables in plaintext", () => {
    // IMP-1's whole point. The mutation replaced encryptSecret(x) with x at one
    // call site and eleven secret-encryption tests stayed green, because they
    // test the module rather than its users.
    const offenders: string[] = [];
    for (const { file, payload } of credentialWrites()) {
      for (const m of payload.matchAll(
        /\b(access_token|refresh_token|auth_token)\s*:\s*([^,\n]+)/g,
      )) {
        const value = m[2].trim();
        if (/^(null|undefined)\b/.test(value)) continue;
        if (/encryptSecret\(/.test(value)) continue;
        // A ternary that encrypts on the truthy side is fine.
        if (/\?\s*encryptSecret\(/.test(value)) continue;
        offenders.push(`${file}: ${m[0].slice(0, 70)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** SQL with BOTH comment forms removed. Stripping only `--` lines let a
 *  mutation that wrapped a CREATE TRIGGER in `/* … *​/` pass this file — the
 *  commented-out statement still matched the regex. A commented-out guard is
 *  not a guard, in either syntax. */
function sqlWithoutComments(sql: string): string {
  return (
    sql
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // An UNTERMINATED /* comments out the rest of the file. Postgres would
      // reject such a migration outright, so this case cannot ship — but leaving
      // it unhandled means the difference between "caught" and "not caught" here
      // rests on whether someone typed the closing marker.
      .replace(/\/\*[\s\S]*$/, "")
      .replace(/^\s*--.*$/gm, "")
  );
}

const ALL_MIGRATIONS = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: sqlWithoutComments(readFileSync(join(MIGRATIONS, f), "utf8")) }));

describe("a database can actually be built from these files", () => {
  it("no two migrations claim the same version", () => {
    // `supabase_migrations.schema_migrations.version` is the PRIMARY KEY, and
    // the version is the filename's leading timestamp. Two files sharing one
    // means the second can never be recorded, so `supabase db reset` — and any
    // fresh environment built from this repo — dies partway through with
    //
    //     ERROR: duplicate key value violates unique constraint
    //            "schema_migrations_pkey"
    //     Key (version)=(20260716170000) already exists.
    //
    // ── WHY NOTHING CAUGHT THIS FOR A MONTH ──────────────────────────────
    //
    // 20260716170000 was used by BOTH annual-plan-prices.sql and
    // signup-requests-payment-intent.sql. Production was never affected: both
    // had already been applied under their real, distinct timestamps
    // (20260716042822 and 20260716070224) and were filed into the repo later
    // with a hand-picked one, twice.
    //
    // That is exactly the case every existing check is blind to.
    // check-migrations compares NAMES against the applied ledger, and both
    // names match. check-baseline-objects asks whether the objects exist, and
    // they do. Neither reads the version, and neither builds anything. The
    // fault is only visible to a replay from empty, which nothing did until
    // the Sandboxes workflow ran for the first time on 2026-08-14 and failed
    // on its first attempt.
    //
    // This test is the cheap half of that discovery: no Docker, no database,
    // no 286-file replay — just the observation that a primary key has to be
    // unique.
    const byVersion = new Map<string, string[]>();
    for (const { file } of ALL_MIGRATIONS) {
      const version = file.split("_")[0];
      byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
    }
    const collisions = [...byVersion.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([version, files]) => `${version}: ${files.join(" + ")}`);
    expect(collisions, "two migrations cannot share one primary key").toEqual([]);
  });

  it("never grants EXECUTE on a function the sequence has not created yet", () => {
    // The second fault the Sandboxes replay found, and the same shape as the
    // first: production is fine because production accumulated state the file
    // sequence never describes.
    //
    //     ERROR: ... At statement: 6
    //     GRANT EXECUTE ON FUNCTION public.roadmap_vote_counts() TO anon
    //
    // Both roadmap functions were granted in 20260731190000 and defined a day
    // later in 20260801091000 — a file named, with some irony, "the drift check
    // counted a grant as a definition". Against the live database the grant
    // succeeded, because both had been created outside the migrations. From
    // empty there was nothing to grant on.
    //
    // Order matters WITHIN a file as well as between files, which is the whole
    // difficulty: a first pass at this scan collected every CREATE in a file
    // before checking that file's GRANTs and reported 129 violations, nearly
    // all of them the ordinary create-then-grant pair. Walking the statements
    // positionally gives 2.
    const CREATE_OR_GRANT =
      /(?<create>CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?<cname>[\w.]+)\s*\()|(?<grant>GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+(?<gname>[\w.]+)\s*\()/gi;
    const bare = (n: string) => n.toLowerCase().replace(/^public\./, "");

    const defined = new Set<string>();
    const premature: string[] = [];
    for (const { file, sql } of ALL_MIGRATIONS) {
      for (const m of sql.matchAll(CREATE_OR_GRANT)) {
        const g = m.groups!;
        if (g.create) {
          defined.add(bare(g.cname));
        } else if (!defined.has(bare(g.gname))) {
          // A guarded grant — one inside a `to_regprocedure(...) IS NOT NULL`
          // block — is deliberate and cannot fail, so it is not a violation.
          const before = sql.slice(0, m.index);
          const blockStart = before.lastIndexOf("DO $$");
          const guarded =
            blockStart !== -1 &&
            before.indexOf("END $$", blockStart) === -1 &&
            before.slice(blockStart).includes("to_regprocedure");
          if (!guarded)
            premature.push(`${file} grants ${bare(g.gname)}() before anything creates it`);
        }
      }
    }
    expect(premature).toEqual([]);
  });

  it("every migration filename starts with a 14-digit timestamp", () => {
    // The version is parsed off the filename by the Supabase CLI and by the
    // three check scripts. A file that does not carry one is not ordered, not
    // recorded, and not compared — it simply is not part of the sequence,
    // silently.
    const malformed = ALL_MIGRATIONS.filter(({ file }) => !/^\d{14}_/.test(file)).map(
      (m) => m.file,
    );
    expect(malformed).toEqual([]);
  });
});

describe("row level security stays on", () => {
  it("no migration ever disables it", () => {
    // Policy-text scans are blind to this: every authz test in this repo reads
    // CREATE POLICY statements, and a later DISABLE ROW LEVEL SECURITY leaves
    // all of them green while the table is wide open.
    const offenders = ALL_MIGRATIONS.filter(({ sql }) =>
      /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i.test(sql),
    ).map((m) => m.file);
    expect(offenders).toEqual([]);
  });

  it("finds the migrations at all", () => {
    // The assertion above is `[].filter(...)` over a directory listing. If that
    // listing were ever empty it would pass while checking nothing.
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(100);
  });
});

describe("the protective triggers are attached to their tables", () => {
  // A trigger FUNCTION with no CREATE TRIGGER is inert, and its body — which is
  // what the tests read — looks perfectly correct.
  const ATTACHED: Array<{ fn: string; table: string }> = [
    { fn: "tg_orgs_protect_platform_columns", table: "organizations" },
    { fn: "tg_credit_ledger_maintain_balance", table: "credit_ledger" },
    { fn: "tg_franchise_invoice_release_on_void", table: "franchise_royalty_invoices" },
    { fn: "tg_franchise_invoice_block_stale_issue", table: "franchise_royalty_invoices" },
    { fn: "tg_dna_matches_guard_billing", table: "dna_matches" },
    { fn: "tg_dna_matches_guard_delete", table: "dna_matches" },
  ];

  for (const { fn, table } of ATTACHED) {
    it(`${fn} is attached to ${table}`, () => {
      // A CREATE TRIGGER naming this function, on this table. Commenting the
      // attachment out — leaving the function body, which is all the other
      // tests read — detaches the guard entirely and was the passing mutation.
      //
      // Known limit, stated rather than papered over: this proves an
      // attachment was written, not that a later migration never dropped it
      // without recreating it. Tracking that properly means replaying the
      // migrations, which is what the integration suite is for. The mutation
      // this closes is the one that actually happened.
      const attachment = new RegExp(
        `CREATE\\s+TRIGGER\\s+\\w+[\\s\\S]{0,400}?ON\\s+public\\.${table}\\b[\\s\\S]{0,400}?` +
          `EXECUTE\\s+(?:PROCEDURE|FUNCTION)\\s+public\\.${fn}\\s*\\(`,
        "i",
      );
      const found = ALL_MIGRATIONS.some(({ sql }) => attachment.test(sql));
      expect(found, `${fn} has no CREATE TRIGGER on ${table}`).toBe(true);
    });
  }
});

describe("every test file on disk actually runs", () => {
  const config = read("vitest.config.ts");

  it("discovers .test.ts and .test.tsx under tests/", () => {
    // vitest's include was tests/**/*.test.ts only, so a failing .test.tsx was
    // never executed and the run reported the same 61 files as before.
    const include = /include:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";
    expect(include).toMatch(/tests\/\*\*\/\*\.test\.\{?ts/);
    expect(include, "a .test.tsx file would be silently skipped").toMatch(/tsx/);
  });

  it("excludes nothing under tests/", () => {
    // BUG-47: a test file CI does not name is a test file CI cannot fail on.
    // Two words in this config removed two money/security files from the run.
    const exclude = /\n\s*exclude:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";
    expect(exclude).not.toMatch(/tests\//);
  });

  it("names every on-disk test file in the discovered set", () => {
    // The count is the check that cannot be argued with. If a file exists and
    // is not matched by the include glob, this fails.
    const onDisk = readdirSync(join(ROOT, "tests"), { recursive: true } as never)
      .filter((f) => typeof f === "string" && /\.test\.tsx?$/.test(f as string))
      .filter((f) => statSync(join(ROOT, "tests", f as string)).isFile());
    expect(onDisk.length).toBeGreaterThan(50);
    const include = /include:\s*\[([^\]]*)\]/.exec(config)?.[1] ?? "";
    const matchesTs = /\.test\.\{?ts/.test(include);
    const matchesTsx = /tsx/.test(include);
    const unmatched = (onDisk as string[]).filter((f) =>
      f.endsWith(".tsx") ? !matchesTsx : !matchesTs,
    );
    expect(unmatched).toEqual([]);
  });
});
