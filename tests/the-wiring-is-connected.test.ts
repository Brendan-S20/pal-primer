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
      // ── LINE COMMENTS FIRST, AND THE ORDER IS THE WHOLE FIX ────────────
      //
      // This used to run last, and the unterminated-block rule below then ate
      // most of two migrations. A `--` comment that happens to contain the two
      // characters `/*` — a file glob is enough, `routes/email/**` — looks like
      // the start of an unterminated block comment, so everything after it was
      // discarded as commented-out:
      //
      //   20260731240000_any-signed-in-user-could-read-and-bill-any-other-tenant
      //     11,824 characters invisible, from a prose line at 127 of 461
      //   20260810140000_six-helpers-that-answered-questions-about-other-peoples-tenants
      //     9,142 characters invisible
      //
      // Both are SECURITY migrations, and every check built on ALL_MIGRATIONS
      // was reading a fraction of them — including "no migration ever disables
      // row level security", which is the one that most needs to see the whole
      // file. Nothing failed; the text simply was not there.
      //
      // Found because a deliberately broken migration would not fail the
      // grant-order scan below. The scan was right and could not see the
      // statement, which is the same shape as the bug 20260801092000 records:
      // "One bug in a checker concealed one bug in the schema, which is the
      // whole argument for mutation-testing the checkers."
      //
      // Stripping `--` lines first makes a `/*` inside prose unreachable. A
      // `--` inside a real block comment is still removed by the block rules
      // that follow, so nothing is lost the other way.
      .replace(/^\s*--.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      // An UNTERMINATED /* comments out the rest of the file. Postgres would
      // reject such a migration outright, so this case cannot ship — but leaving
      // it unhandled means the difference between "caught" and "not caught" here
      // rests on whether someone typed the closing marker.
      .replace(/\/\*[\s\S]*$/, "")
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
    // REVOKE counts too, and that is not hypothetical — it is the THIRD fault
    // the replay found, one round after the grants above were fixed:
    //
    //     ERROR: function public.email_queue_dispatch() does not exist
    //     At statement: 19
    //     REVOKE EXECUTE ON FUNCTION public.email_queue_dispatch() FROM authenticated
    //
    // That function was never created by any migration at all — it arrived with
    // the Lovable email scaffold, straight into the live database, and was
    // dropped a day later by 20260801092000. The first version of this scan
    // looked only at GRANT and sailed straight past it.
    //
    // ── THREE THINGS THIS SCAN HAS TO GET RIGHT ──────────────────────────
    //
    // 1. POSITION. Order matters within a file as well as between files. A
    //    first pass collected every CREATE in a file before checking that
    //    file's GRANTs and reported 129 violations, nearly all of them the
    //    ordinary create-then-grant pair sitting in one file.
    //
    // 2. DROP. A function can be created and later removed, and an ACL
    //    statement after the DROP is just as broken as one before the CREATE.
    //
    // 3. ARITY. Postgres identifies a function by name AND argument types, so
    //    one name can be several functions — exactly the caveat
    //    dead-machinery-baseline.json records for skip_visit. Keying on the
    //    name alone reported file_reversal_review_item as a violation: it has
    //    FIVE signatures created and dropped across five migrations, and an
    //    early DROP of the 5-argument version made a later REVOKE on the
    //    8-argument version look unmatched. Keyed on name + arity: not a
    //    violation, correctly.
    //
    // Each of those three, left out, changes the answer. 129, then 2, then 1.
    const FUNCTION_STMT =
      /(?<kind>CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION|DROP\s+FUNCTION(?:\s+IF\s+EXISTS)?|(?:GRANT|REVOKE)\s+EXECUTE\s+ON\s+FUNCTION)\s+(?<name>[\w.]+)\s*\(/gi;
    const bare = (n: string) => n.toLowerCase().replace(/^public\./, "");

    /** Argument count, by counting depth-0 commas from the opening paren. */
    const arity = (sql: string, open: number) => {
      let depth = 0;
      let commas = 0;
      let body = "";
      for (let i = open; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "(") {
          depth++;
          if (depth === 1) continue;
        } else if (ch === ")") {
          depth--;
          if (depth === 0) break;
        }
        if (depth === 1) {
          body += ch;
          if (ch === ",") commas++;
        }
      }
      return body.trim() === "" ? 0 : commas + 1;
    };

    const live = new Set<string>();
    const premature: string[] = [];
    for (const { file, sql } of ALL_MIGRATIONS) {
      for (const m of sql.matchAll(FUNCTION_STMT)) {
        const kind = m.groups!.kind.toUpperCase();
        const key = `${bare(m.groups!.name)}/${arity(sql, m.index! + m[0].length - 1)}`;
        if (kind.startsWith("CREATE")) {
          live.add(key);
        } else if (kind.startsWith("DROP")) {
          live.delete(key);
        } else if (!live.has(key)) {
          // An ACL statement inside a `to_regprocedure(...) IS NOT NULL` block
          // is deliberate and cannot fail, so it is not a violation.
          const before = sql.slice(0, m.index);
          const blockStart = before.lastIndexOf("DO $$");
          const guarded =
            blockStart !== -1 &&
            before.indexOf("END $$", blockStart) === -1 &&
            before.slice(blockStart).includes("to_regprocedure");
          if (!guarded) {
            const verb = kind.split(/\s+/)[0].toLowerCase();
            premature.push(`${file} ${verb}s EXECUTE on ${key} when no such function is live`);
          }
        }
      }
    }
    expect(premature).toEqual([]);
  });

  it("never raises on a cron job the sequence has not scheduled", () => {
    // The fifth fault the Sandboxes replay found, and the only one it found
    // TWICE — because the first fix was wrong:
    //
    //     ERROR: the process-email-queue cron job is missing or inactive (SQLSTATE P0001)
    //
    // A cron job is operations state. `process-email-queue` was scheduled by
    // hand against the live database and no migration creates it, so a database
    // built from these files does not have it and 20260801092000 refused to
    // apply. Same family as the three faults above — repo and production
    // disagreeing — but the mirror image of them: not the repo failing to
    // describe something production has, the repo DEMANDING something only
    // production has.
    //
    // ── WHY THE FIRST FIX FAILED, WHICH IS THE POINT OF THIS TEST ────────
    //
    // Both offending migrations were guarded with
    //
    //     IF EXISTS (SELECT 1 FROM cron.job) AND NOT EXISTS (...)
    //
    // on the stated reasoning that "an entirely empty cron.job is the signature
    // of a freshly built database". It is not. 20260716220000 schedules
    // `run-billing-cycles` and 20260731130000 schedules `weekly-digest`, both
    // long before either check runs, so cron.job holds two rows on a fresh
    // build and the precondition passes. Replay 6 failed on the same line as
    // replay 5, with the new code visible in the log.
    //
    // That was a claim about these files, checkable against these files, and I
    // shipped it without checking. Hence a test rather than a better guard:
    // the question "does anything here create this job" has an answer on disk,
    // and it takes a millisecond to read instead of a twelve-minute replay.
    //
    // ── WHAT IT ALLOWS ───────────────────────────────────────────────────
    //
    // Not "no migration may mention cron". A migration MAY hard-assert a job
    // that an earlier migration schedules — 20260801111000 asserts
    // run_billing_cycles and keeps its exception, because the replay creates
    // that job before it gets there. What is forbidden is raising on a job the
    // sequence never creates. RAISE WARNING is always fine: it says the same
    // thing to an operator without stopping a build that cannot comply.
    const scheduled: Array<{ file: string; name: string; call: string }> = [];
    // A Set, because one IF can read cron.job twice — the wrong guard did
    // exactly that — and the same finding printed twice is noise, not detail.
    const unschedulable = new Set<string>();

    for (const { file, sql } of ALL_MIGRATIONS) {
      // Every `cron.job` read, widened to the IF ... END IF around it, so the
      // question "does this one raise" is asked of the right block. A file can
      // hold several: 20260716220000 tests for the job, then schedules it.
      for (const hit of [...sql.matchAll(/cron\.job\b/gi)]) {
        const openIf = sql.lastIndexOf("IF ", hit.index!);
        const closeIf = sql.toUpperCase().indexOf("END IF", hit.index!);
        if (openIf === -1 || closeIf === -1) continue;
        const block = sql.slice(openIf, closeIf);
        if (!/RAISE\s+EXCEPTION/i.test(block)) continue;

        // What the block demands, in the two forms this repo writes: by job
        // name, or by what the job's command calls.
        const byName = /jobname\s*=\s*'([^']+)'/i.exec(block)?.[1];
        const byCommand = /command\s+I?LIKE\s*'%([^%']+)%'/i.exec(block)?.[1];
        const satisfied = scheduled.some(
          (s) =>
            (byName !== undefined && s.name === byName) ||
            (byCommand !== undefined && s.call.toLowerCase().includes(byCommand.toLowerCase())),
        );
        if (!satisfied) {
          unschedulable.add(
            `${file} raises unless a cron job ${
              byName ? `named '${byName}'` : byCommand ? `running '${byCommand}'` : "(unparsed)"
            } exists, and no earlier migration schedules one`,
          );
        }
      }

      // Collected AFTER the checks above, so a file cannot satisfy its own
      // assertion with a schedule written below it — the same positional point
      // the grant-order scan had to learn, where collecting first turned 2 real
      // findings into 129 false ones.
      for (const m of sql.matchAll(/cron\.schedule\s*\(\s*'([^']+)'/gi)) {
        scheduled.push({
          file,
          name: m[1],
          // 2000 characters is past the end of the longest schedule call here
          // (the weekly digest's http_post body, ~700); the slice only has to
          // reach the command argument.
          call: sql.slice(m.index!, m.index! + 2000),
        });
      }
    }

    // The scan is a `.filter` over parsed text, and would report a clean sweep
    // if the parse found nothing at all. Both halves are pinned.
    expect(
      scheduled.map((s) => s.name).sort(),
      "no cron.schedule found — the scan is reading nothing",
    ).toEqual(["run-billing-cycles", "weekly-digest"]);
    expect([...unschedulable]).toEqual([]);
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
