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
      for (const m of payload.matchAll(/\b(access_token|refresh_token|auth_token)\s*:\s*([^,\n]+)/g)) {
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
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // An UNTERMINATED /* comments out the rest of the file. Postgres would
    // reject such a migration outright, so this case cannot ship — but leaving
    // it unhandled means the difference between "caught" and "not caught" here
    // rests on whether someone typed the closing marker.
    .replace(/\/\*[\s\S]*$/, "")
    .replace(/^\s*--.*$/gm, "");
}

const ALL_MIGRATIONS = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: sqlWithoutComments(readFileSync(join(MIGRATIONS, f), "utf8")) }));

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
