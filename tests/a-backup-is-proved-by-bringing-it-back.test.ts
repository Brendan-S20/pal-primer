// #720 got the nightly encrypted backup working again (Backup run #38, Nov
// 7). Nobody had restored one by hand, so nobody knew whether a backup could
// bring the database back. scripts/restore-drill.sh is the drill a person
// runs on a private machine; scripts/restore-drill-selftest.sh proves it on
// seed data in sandboxes.yml's database job. This file pins what makes either
// one worth trusting:
//
//   * it writes only to a database on THIS machine, and says so before it
//     loads anything;
//   * every check FAILS on the restore it exists to catch, rather than
//     passing on a restore of nothing;
//   * the backup carries the migration ledger, which until this change it did
//     not: `supabase db dump` leaves supabase_migrations out, so a project
//     restored from any backup before this had every table and no record of
//     which migrations made them;
//   * only backup.yml and restore-drill.yml read a production backup, both
//     on GitHub-hosted runners (the owner's decision, 2026-11-10: "Yes, run
//     the weekly restore drill on a GitHub runner"), and the self-test reads
//     no secret.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { countExtensionState } from "../scripts/backup/copy-row-counts.mjs";
import { checkLocalDbUrl } from "../scripts/backup/local-only.mjs";
import {
  ALL_PASSED_PREFIX,
  DRILL_KEY_TABLES,
  evaluate,
  expectedPublicTables,
  migrationFiles,
  newestVersion,
} from "../scripts/backup/restore-drill-checks.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const code = (p: string) =>
  read(p)
    .split("\n")
    .filter((l) => !/^\s*(#|\/\/)/.test(l))
    .join("\n");

describe("the drill writes only to a database on this machine", () => {
  it.each([
    "postgresql://postgres:postgres@127.0.0.1:62222/postgres",
    "postgres://postgres:pw@localhost:5432/postgres",
    "postgresql://postgres:pw@[::1]:5432/postgres",
    "postgresql://postgres:pw@LOCALHOST:5432/postgres?sslmode=disable",
  ])("accepts %s", (url) => {
    expect(checkLocalDbUrl(url)).toEqual({ ok: true });
  });

  it.each([
    [
      "a Supabase pooler",
      "postgresql://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:5432/postgres",
    ],
    ["a project host", "postgresql://postgres:pw@db.abcdefgh.supabase.co:5432/postgres"],
    ["a LAN address", "postgresql://postgres:pw@192.168.1.20:5432/postgres"],
    [
      "a name that only resolves to loopback",
      "postgresql://postgres:pw@127.0.0.1.nip.io:5432/postgres",
    ],
    [
      "a second host after a local one",
      "postgresql://postgres:pw@127.0.0.1:5432,db.example.com:5432/postgres",
    ],
    ["a host parameter", "postgresql://postgres:pw@127.0.0.1:5432/postgres?host=db.example.com"],
    ["a hostaddr parameter", "postgresql://postgres:pw@localhost/postgres?hostaddr=10.0.0.5"],
    ["a service parameter", "postgresql://localhost/postgres?service=prod"],
    ["no host at all", "postgresql:///postgres"],
    ["not a postgres URL", "https://127.0.0.1/"],
    ["nothing", ""],
  ])("refuses %s", (_label, url) => {
    expect(checkLocalDbUrl(url).ok).toBe(false);
  });

  it("refuses from the command line without printing the URL or its password", () => {
    let out = "";
    let code = 0;
    try {
      execFileSync("node", [join(ROOT, "scripts/backup/local-only.mjs")], {
        env: {
          ...process.env,
          RESTORE_TARGET_URL: "postgresql://postgres:hunter2-not-real@db.example.com:5432/postgres",
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      code = err.status;
      out = err.stdout + err.stderr;
    }
    expect(code).toBe(1);
    expect(out).toMatch(/REFUSING/);
    expect(out).not.toContain("hunter2");
  });

  it("checks the target in drill.sh BEFORE restore.sh loads anything into it", () => {
    const drill = code("scripts/backup/drill.sh");
    const guard = drill.indexOf("local-only.mjs");
    const restore = drill.indexOf('"$here/restore.sh"');
    expect(guard).toBeGreaterThan(0);
    expect(restore).toBeGreaterThan(guard);
  });

  it("refuses a Docker daemon on another machine", () => {
    expect(code("scripts/restore-drill.sh")).toMatch(/DOCKER_HOST/);
  });
});

describe("the passphrase is never shown", () => {
  for (const p of ["scripts/restore-drill.sh", "scripts/restore-drill-selftest.sh"]) {
    it(`${p} never echoes, prints or passes it as an argument`, () => {
      const lines = code(p)
        .split("\n")
        .filter((l) => l.includes("BACKUP_PASSPHRASE"));
      for (const l of lines) {
        expect(l).not.toMatch(/\b(echo|printf)\b/);
        expect(l).not.toMatch(/--passphrase(?!-fd)/);
      }
    });
  }

  it("the self-test overwrites any passphrase it inherits with one made for the run", () => {
    expect(code("scripts/restore-drill-selftest.sh")).toMatch(
      /BACKUP_PASSPHRASE="\$\(openssl rand -base64 32\)"/,
    );
  });

  it("the drill stack's banner, which prints keys, is filtered", () => {
    expect(code("scripts/backup/drill.sh")).toMatch(
      /supabase start -x "\$exclude" 2>&1 \| \{ grep -viE 'key\|secret/,
    );
  });
});

describe("each check fails on the restore it exists to catch", () => {
  const expectedTables = ["clients", "invoices", "organizations", "staff", "visits", "zones"];
  const good = () => ({
    relations: [...expectedTables],
    rls_off: [] as string[],
    base_tables: expectedTables.length,
    auth_schema: true,
    auth_users: true,
    auth_user_count: 3,
    ledger: true,
    ledger_rows: 512,
    ledger_newest: "20261109200000",
    counts: { organizations: 2, clients: 10, visits: 149, invoices: 34, staff: 4 } as Record<
      string,
      number | null
    >,
  });
  const run = (facts: ReturnType<typeof good>) =>
    evaluate(facts, { expectedTables, repoNewest: "20261109200000" });

  it("passes a complete restore, and prints only names and numbers", () => {
    const r = run(good());
    expect(r.failed).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.lines.filter((l) => l.startsWith("PASS"))).toHaveLength(5);
    for (const l of r.lines) expect(l).toMatch(/^[\w\s.,():'"-]*$/);
  });

  it("tables: a table the migrations create is missing", () => {
    const f = good();
    f.relations = f.relations.filter((t) => t !== "zones");
    const r = run(f);
    expect(r.failed).toEqual(["tables"]);
    expect(r.lines.join("\n")).toMatch(/missing: public\.zones/);
  });

  it("rows: organizations is empty, which every count-matches check passes", () => {
    const f = good();
    f.counts.organizations = 0;
    expect(run(f).failed).toEqual(["rows"]);
  });

  it("rows: a key table is absent", () => {
    const f = good();
    f.counts.staff = null;
    expect(run(f).failed).toEqual(["rows"]);
  });

  it("rls: one public table came back without row level security", () => {
    const f = good();
    f.rls_off = ["clients"];
    const r = run(f);
    expect(r.failed).toEqual(["rls"]);
    expect(r.lines.join("\n")).toMatch(/RLS off: public\.clients/);
  });

  it("auth: no auth schema, no auth.users, or nobody in it", () => {
    for (const patch of [{ auth_schema: false }, { auth_users: false }, { auth_user_count: 0 }]) {
      expect(run({ ...good(), ...patch }).failed).toEqual(["auth"]);
    }
  });

  it("ledger: absent or empty, which every backup before this change was", () => {
    expect(run({ ...good(), ledger: false }).failed).toEqual(["ledger"]);
    expect(run({ ...good(), ledger_rows: 0 }).failed).toEqual(["ledger"]);
  });

  it("ledger: a backup older than the checkout passes and says so", () => {
    const r = evaluate(
      { ...good(), ledger_newest: "20261101000000" },
      { expectedTables, repoNewest: "20261109200000" },
    );
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toMatch(/newer than the backup/);
  });

  it("asks about the tables the runbook names", () => {
    expect(DRILL_KEY_TABLES).toEqual(["organizations", "clients", "visits", "invoices", "staff"]);
  });
});

describe("what the migrations are expected to leave behind", () => {
  const files = migrationFiles();
  const tables = expectedPublicTables(files);

  it("is replayed from the real migrations, key tables included", () => {
    expect(tables.length).toBeGreaterThan(100);
    for (const t of DRILL_KEY_TABLES) expect(tables).toContain(t);
  });

  it("does not expect a table a later migration dropped", () => {
    expect(tables).not.toContain("org_ai_credentials");
  });

  it("names the newest migration file's version", () => {
    const newest = readdirSync(join(ROOT, "supabase/migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .at(-1)!;
    expect(newestVersion(files)).toBe(newest.split("_")[0]);
  });
});

describe("the backup carries the migration ledger", () => {
  it("dump.sh writes one INSERT per applied migration into extension-state.sql", () => {
    const dump = code("scripts/backup/dump.sh");
    expect(dump).toMatch(/CREATE TABLE IF NOT EXISTS supabase_migrations\.schema_migrations/);
    expect(dump).toMatch(
      /INSERT INTO supabase_migrations\.schema_migrations \(version, name\)[^\n]*ON CONFLICT \(version\) DO NOTHING/,
    );
  });

  it("is counted, so the drill checks every migration came back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const withLedger = join(dir, "with.sql");
    writeFileSync(
      withLedger,
      [
        "SELECT pgmq.create('auth_emails');",
        "CREATE SCHEMA IF NOT EXISTS supabase_migrations;",
        "CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY, statements text[], name text);",
        "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20260101000000', 'a') ON CONFLICT (version) DO NOTHING;",
        "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20260102000000', 'b') ON CONFLICT (version) DO NOTHING;",
        "",
      ].join("\n"),
    );
    expect(await countExtensionState(withLedger)).toEqual({
      "cron.job": 0,
      "pgmq.meta": 1,
      "supabase_migrations.schema_migrations": 2,
    });
  });

  it("is not counted at all in an older archive, so its own restore count still matches", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ledger-"));
    const old = join(dir, "old.sql");
    writeFileSync(old, "SELECT pgmq.create('auth_emails');\n");
    expect(await countExtensionState(old)).toEqual({ "cron.job": 0, "pgmq.meta": 1 });
  });
});

describe("only backup.yml and restore-drill.yml touch a production backup", () => {
  const workflows = readdirSync(join(ROOT, ".github/workflows")).filter((f) => /\.ya?ml$/.test(f));

  it("only backup.yml and restore-drill.yml download the db-backup artifact", () => {
    const downloading = workflows.filter((f) =>
      /download-artifact[\s\S]{0,200}name:\s*db-backup\b/.test(read(`.github/workflows/${f}`)),
    );
    expect(downloading.sort()).toEqual(["backup.yml", "restore-drill.yml"]);
  });

  it("no other workflow runs restore-drill.sh", () => {
    for (const f of workflows.filter((w) => w !== "restore-drill.yml")) {
      // Named in a paths filter or the database gate is fine: that routes a
      // change to the self-test. Any other mention is a step running it.
      const runs = code(`.github/workflows/${f}`)
        .split("\n")
        .filter((l) => l.includes("scripts/restore-drill.sh"))
        .filter(
          (l) => !/^\s+- "scripts\/restore-drill\.sh"$/.test(l) && !/\) database=true ;;$/.test(l),
        );
      expect(runs, f).toEqual([]);
    }
  });

  it("the self-test step reads no secret and runs only the self-test", () => {
    const yml = read(".github/workflows/sandboxes.yml");
    const step = yml.match(
      /- name: The restore drill, on a backup of local seed data\n([\s\S]*?)\n\n/,
    );
    expect(step).not.toBeNull();
    expect(step![1]).toMatch(/scripts\/restore-drill-selftest\.sh/);
    expect(step![1]).not.toMatch(/secrets\./);
  });

  it("the self-test refuses a stack off this machine before it seeds", () => {
    const s = code("scripts/restore-drill-selftest.sh");
    const guard = s.indexOf("local-only.mjs");
    const seed = s.indexOf("restore-drill-seed.sql");
    expect(guard).toBeGreaterThan(0);
    expect(seed).toBeGreaterThan(guard);
  });
});

type Job = {
  "runs-on"?: string;
  if?: string;
  needs?: string;
  steps: {
    name?: string;
    uses?: string;
    run?: string;
    env?: Record<string, string>;
    with?: Record<string, unknown>;
  }[];
};

describe("the weekly restore drill on a GitHub runner", () => {
  const raw = read(".github/workflows/restore-drill.yml");
  const wf = load(raw) as {
    on: { schedule: { cron: string }[]; workflow_dispatch: unknown };
    permissions: Record<string, string>;
    jobs: Record<string, Job>;
  };

  it("runs weekly on a schedule, and by hand", () => {
    expect(wf.on.schedule).toHaveLength(1);
    const [, , dom, month, dow] = wf.on.schedule[0].cron.split(/\s+/);
    expect([dom, month]).toEqual(["*", "*"]);
    expect(dow).toMatch(/^[0-6]$/);
    expect("workflow_dispatch" in wf.on).toBe(true);
  });

  it("is GitHub-hosted Ubuntu, written out, for every job", () => {
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job["runs-on"], `${name}: runs-on`).toBe("ubuntu-latest");
    }
    expect(raw).not.toMatch(/runs-on:.*vars\./);
  });

  it("can read artifacts and write nothing", () => {
    expect(wf.permissions).toEqual({ contents: "read", actions: "read" });
  });

  it("names one existing secret, and no database URL at all", () => {
    const secrets = [...new Set([...raw.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(secrets).toEqual(["BACKUP_PASSPHRASE"]);
    // Comments may say why there is none; the configuration may not have one.
    expect(code(".github/workflows/restore-drill.yml")).not.toMatch(
      /SUPABASE_DB_URL|DATABASE_URL|db-url/,
    );
  });

  it("skips the drill with a message when the passphrase is missing, never seeing its value", () => {
    const check = wf.jobs.preflight.steps.find((s) => s.env?.HAS_PASSPHRASE);
    expect(check?.env?.HAS_PASSPHRASE).toBe("${{ secrets.BACKUP_PASSPHRASE != '' }}");
    expect(check?.run).toMatch(/BACKUP_PASSPHRASE is not set[\s\S]*SKIPPED/);
    expect(check?.run).toMatch(/ready=false/);
    expect(wf.jobs.drill.needs).toBe("preflight");
    expect(wf.jobs.drill.if).toBe("needs.preflight.outputs.ready == 'true'");
  });

  it("fails, not skips, when there is no backup to drill", () => {
    const check = wf.jobs.preflight.steps.find((s) => s.env?.HAS_PASSPHRASE);
    expect(check?.run).toMatch(/no unexpired db-backup artifact[\s\S]*?exit 1/);
  });

  it("downloads the newest backup and its summary from that run, and drills them with restore-drill.sh", () => {
    const steps = wf.jobs.drill.steps;
    const downloads = steps.filter((s) => s.uses?.startsWith("actions/download-artifact@"));
    expect(downloads.map((s) => s.with?.name)).toEqual(["db-backup", "db-backup-summary"]);
    for (const d of downloads)
      expect(d.with?.["run-id"]).toBe("${{ needs.preflight.outputs.run_id }}");
    const drill = steps.find((s) => s.run?.includes("scripts/restore-drill.sh"));
    expect(drill?.run).toMatch(/set -o pipefail/);
    expect(drill?.run).toMatch(/BACKUP_SUMMARY=/);
    expect(drill?.env).toEqual({ BACKUP_PASSPHRASE: "${{ secrets.BACKUP_PASSPHRASE }}" });
  });

  it("only the drill step is handed the passphrase", () => {
    const holders = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .filter((s) => JSON.stringify(s).includes("secrets.BACKUP_PASSPHRASE }}"));
    expect(holders.map((s) => s.name)).toEqual(["Restore and check"]);
  });
});

describe("a check that never ran is not a pass", () => {
  // Found on 2026-11-10: run through a symlinked checkout, both scripts'
  // "am I the entry point" test compared two different URLs, skipped their
  // main block, and exited 0. local-only.mjs then let any URL through and
  // restore-drill-checks.mjs printed nothing, and the drill said PASS.
  const dir = mkdtempSync(join(tmpdir(), "symlinked-"));
  const linked = join(dir, "scripts");
  symlinkSync(join(ROOT, "scripts"), linked);

  it("local-only.mjs still refuses a remote URL when reached through a symlink", () => {
    let status = 0;
    let out = "";
    try {
      out = execFileSync("node", [join(linked, "backup/local-only.mjs")], {
        env: {
          ...process.env,
          RESTORE_TARGET_URL: "postgresql://u:p@db.example.com:5432/postgres",
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (e) {
      status = (e as { status: number }).status;
    }
    expect(status).toBe(1);
    expect(out).not.toBe("local\n");
  });

  it("restore-drill-checks.mjs still runs, and refuses, through a symlink", () => {
    let status = 0;
    let err = "";
    try {
      execFileSync("node", [join(linked, "backup/restore-drill-checks.mjs")], {
        env: {
          ...process.env,
          RESTORE_TARGET_URL: "postgresql://u:p@db.example.com:5432/postgres",
        },
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf8",
      });
    } catch (e) {
      status = (e as { status: number }).status;
      err = (e as { stderr: string }).stderr;
    }
    expect(status).toBe(1);
    expect(err).toMatch(/REFUSING/);
  });

  it("every caller of local-only.mjs requires it to print `local`, not just to exit 0", () => {
    for (const p of [
      "scripts/backup/drill.sh",
      "scripts/restore-drill.sh",
      "scripts/restore-drill-selftest.sh",
    ]) {
      const calls = code(p)
        .split("\n")
        .filter((l) => l.includes("local-only.mjs"));
      expect(calls.length, p).toBeGreaterThan(0);
      for (const l of calls)
        expect(l, p).toMatch(/\[ "\$\(RESTORE_TARGET_URL=.*local-only\.mjs"?\)" (!?=) "local" \]/);
    }
  });

  it("restore-drill.sh says PASS only after the checks report all five passing", () => {
    const s = code("scripts/restore-drill.sh");
    const sentinel = s.indexOf(`"all restore drill checks passed: 5"`);
    const pass = s.indexOf("RESTORE DRILL: PASS");
    expect(sentinel).toBeGreaterThan(0);
    expect(pass).toBeGreaterThan(sentinel);
    expect(ALL_PASSED_PREFIX).toBe("all restore drill checks passed:");
  });
});

describe("a public log shows production counts only when something failed", () => {
  // The repository is public, and so are its Actions logs and step summaries.
  // A pass says "N of N" and PASS; how many customers, visits and logins
  // production holds is printed only when a check failed, where it is what a
  // person needs to see first.
  const expectedTables = ["clients", "invoices", "organizations", "staff", "visits"];
  const facts = () => ({
    relations: [...expectedTables],
    rls_off: [] as string[],
    base_tables: expectedTables.length,
    auth_schema: true,
    auth_users: true,
    auth_user_count: 4321,
    ledger: true,
    ledger_rows: 515,
    ledger_newest: "20261110130000",
    counts: {
      organizations: 1234,
      clients: 56789,
      visits: 987654,
      invoices: 24680,
      staff: 1357,
    } as Record<string, number | null>,
  });
  const secretCounts = ["1234", "56789", "987654", "24680", "1357", "4321"];
  const run = (f: ReturnType<typeof facts>) =>
    evaluate(f, { expectedTables, repoNewest: "20261110130000" }).lines.join("\n");

  it("a pass prints no row count of any key table, nor of auth.users", () => {
    const out = run(facts());
    for (const n of secretCounts) expect(out).not.toContain(n);
    expect(out).toMatch(/5 of 5 key tables present and organizations is not empty/);
    expect(out).toMatch(/auth schema present and auth\.users is not empty/);
  });

  it("a failure prints every key table's count and the auth.users count", () => {
    const f = facts();
    f.rls_off = ["clients"];
    const out = run(f);
    expect(out).toMatch(/row counts \(printed because a check failed\)/);
    for (const n of secretCounts) expect(out).toContain(n);
  });

  it("verify-restore.mjs prints the key tables' counts only inside its failure branch", () => {
    const v = code("scripts/backup/verify-restore.mjs");
    const branch = v.indexOf("if (failures.length) {");
    const keyLoop = v.indexOf("for (const t of KEY_TABLES) {\n    console.log(");
    expect(branch).toBeGreaterThan(0);
    expect(keyLoop).toBeGreaterThan(branch);
    // and nowhere before it
    expect(v.slice(0, branch)).not.toMatch(/console\.log\([^)]*expected\[t\]/);
  });

  it("the step summary copies PASS/FAIL lines and totals, never an indented count line", () => {
    const wf = load(read(".github/workflows/restore-drill.yml")) as { jobs: Record<string, Job> };
    const summary = wf.jobs.drill.steps.find((s) => s.name === "Summary")!;
    expect(summary.run).toMatch(
      /grep -E '\^\(PASS\|FAIL\|RESTORE DRILL:\|::error::\)\|tables restored with exactly'/,
    );
  });
});

describe("a scheduled drill with no passphrase is red, not a green skip", () => {
  const wf = load(read(".github/workflows/restore-drill.yml")) as { jobs: Record<string, Job> };
  const run = wf.jobs.preflight.steps.find((s) => s.env?.HAS_PASSPHRASE)!.run!;
  const sh = (event: string) => {
    const dir = mkdtempSync(join(tmpdir(), "preflight-"));
    const out = join(dir, "out");
    writeFileSync(out, "");
    try {
      const stdout = execFileSync("bash", ["-e", "-c", run], {
        env: {
          PATH: process.env.PATH,
          HAS_PASSPHRASE: "false",
          GITHUB_EVENT_NAME: event,
          GITHUB_OUTPUT: out,
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { status: 0, stdout, output: readFileSync(out, "utf8") };
    } catch (e) {
      const err = e as { status: number; stdout: string };
      return { status: err.status, stdout: err.stdout, output: readFileSync(out, "utf8") };
    }
  };

  it("on schedule: exits 1 with an error naming the secret", () => {
    const r = sh("schedule");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/::error::BACKUP_PASSPHRASE is not set/);
    expect(r.output).not.toMatch(/ready=true/);
  });

  it("by hand: warns, sets ready=false, and the drill job is skipped", () => {
    const r = sh("workflow_dispatch");
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/::warning::BACKUP_PASSPHRASE is not set[\s\S]*SKIPPED/);
    expect(r.output).toMatch(/ready=false/);
  });
});
