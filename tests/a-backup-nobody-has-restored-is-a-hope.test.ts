// Production is Supabase Pro without point-in-time recovery. Until
// .github/workflows/backup.yml, its only backups were seven daily snapshots
// held by the same company as the database, restorable only by rolling every
// tenant back at once. The owner: "We do need backups and restores, I do not
// pay for point-in-time recovery."
//
// The workflow makes a second, encrypted copy every night and RESTORES it
// every Sunday. docs/backups-and-restore.md is the runbook. This file pins
// the parts of that design that are easy to undo by accident, each of which
// would leave a job that is green and protects nothing -- or worse:
//
//   * a job moved onto a self-hosted runner, so every customer's data in
//     plaintext lands in a work directory on a laptop;
//   * an upload step moved above the encryption, or pointed at the dump
//     directory, so the plaintext becomes a downloadable artifact;
//   * a drill that restores and then checks nothing, or checks counts against
//     a backup of nothing;
//   * a restore that brings cron jobs back LIVE, so the restored copy starts
//     calling production and customers' webhook endpoints within a minute.
//
// And it exercises the one piece of logic every count depends on --
// counting rows in a COPY dump -- against a dump written to be awkward.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { countCopyRows, countExtensionState } from "../scripts/backup/copy-row-counts.mjs";
import { KEY_TABLES, MUST_NOT_BE_EMPTY } from "../scripts/backup/key-tables.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type Step = { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, unknown> };
type Job = { "runs-on": string; needs?: string; if?: string; steps: Step[] };
const raw = read(".github/workflows/backup.yml");
const wf = load(raw) as { on: { schedule: Array<{ cron: string }> }; jobs: Record<string, Job> };
const backup = wf.jobs.backup;
const drill = wf.jobs["restore-drill"];

const indexOf = (steps: Step[], pred: (s: Step) => boolean, what: string) => {
  const i = steps.findIndex(pred);
  if (i < 0) throw new Error(`no step that ${what}`);
  return i;
};

describe("where the backup runs", () => {
  it("is GitHub-hosted Ubuntu, written out, for every job", () => {
    // Not `vars.UNIX_RUNNER || vars.CI_RUNNER || ...` like the rest of the
    // repo. Those resolve to the owner's Mac or the Windows box today; one
    // keeps a work directory full of whatever a crashed step left, the other
    // has no bash, gpg or Docker. A hosted VM is destroyed after the job.
    for (const [name, job] of Object.entries(wf.jobs)) {
      expect(job["runs-on"], `${name}: runs-on`).toBe("ubuntu-latest");
    }
    expect(raw).not.toMatch(/runs-on:.*vars\./);
  });

  it("runs every night, and the drill's condition names a schedule that exists", () => {
    // Two cron lines for one time because an expression cannot ask the
    // weekday. If the Sunday line is edited and the drill's `if` is not, the
    // drill never runs again and nothing says so.
    const crons = wf.on.schedule.map((s) => s.cron);
    const days = new Set<string>();
    for (const c of crons) {
      const dow = c.split(/\s+/)[4];
      if (dow === "*") ["0", "1", "2", "3", "4", "5", "6"].forEach((d) => days.add(d));
      else if (/^\d-\d$/.test(dow)) for (let d = +dow[0]; d <= +dow[2]; d++) days.add(String(d));
      else dow.split(",").forEach((d) => days.add(d));
    }
    expect([...days].sort()).toEqual(["0", "1", "2", "3", "4", "5", "6"]);

    const named = [...(drill.if ?? "").matchAll(/github\.event\.schedule == '([^']+)'/g)].map((m) => m[1]);
    expect(named.length, "the drill is not tied to any schedule").toBeGreaterThan(0);
    for (const c of named) expect(crons, `the drill waits for "${c}", which never fires`).toContain(c);
  });
});

describe("nothing leaves the machine unencrypted", () => {
  const steps = backup.steps;
  const uploads = steps.filter((s) => s.uses?.startsWith("actions/upload-artifact"));

  it("checks the passphrase before dumping anything", () => {
    const check = indexOf(steps, (s) => /crypt\.sh check/.test(s.run ?? ""), "checks the passphrase");
    const dump = indexOf(steps, (s) => /dump\.sh/.test(s.run ?? ""), "dumps");
    expect(check).toBeLessThan(dump);
  });

  it("seals before any upload, and uploads only the sealed file and the summary", () => {
    const seal = indexOf(steps, (s) => /crypt\.sh seal/.test(s.run ?? ""), "seals the dump");
    expect(uploads.length).toBe(2);
    for (const u of uploads) {
      expect(steps.indexOf(u)).toBeGreaterThan(seal);
      expect(u.if, "an upload that runs when sealing failed").toMatch(/steps\.seal\.outcome == 'success'/);
      const path = String(u.with?.path);
      expect(path, "an upload path that could match the plaintext dump").toMatch(
        /^(sealed\/\*\.tar\.gz\.gpg|summary\/summary\.json)$/,
      );
    }
  });

  it("keeps the encrypted backup 30 days, longer than Supabase's own 7", () => {
    const enc = uploads.find((u) => String(u.with?.path).endsWith(".gpg"))!;
    expect(enc.with?.name).toBe("db-backup");
    expect(enc.with?.["retention-days"]).toBe(30);
  });

  it("encrypts with gpg AES-256 and never puts the passphrase on a command line", () => {
    const crypt = read("scripts/backup/crypt.sh");
    expect(crypt).toMatch(/--symmetric --cipher-algo AES256/);
    expect(crypt).toMatch(/--passphrase-fd 3/);
    expect(crypt).not.toMatch(/--passphrase "/);
    expect(crypt).toMatch(/MIN_LEN=\d\d/);
  });

  it("removes the plaintext dump whether or not the job succeeded", () => {
    const rm = steps.find((s) => /rm -rf "\$RUNNER_TEMP\/dump"/.test(s.run ?? ""));
    expect(rm?.if).toBe("always()");
  });
});

describe("the backup is the one Supabase documents, auth included", () => {
  const dump = read("scripts/backup/dump.sh");

  it("dumps roles, schema and data separately with the Supabase CLI", () => {
    expect(dump).toMatch(/supabase db dump --db-url "\$SUPABASE_DB_URL" -f "\$out\/roles\.sql" --role-only/);
    expect(dump).toMatch(/supabase db dump --db-url "\$SUPABASE_DB_URL" -f "\$out\/schema\.sql"\n/);
    expect(dump).toMatch(/-f "\$out\/data\.sql" --use-copy --data-only/);
  });

  it("does not narrow the data dump to a schema list, which would drop auth.users", () => {
    // `--schema public` on the data dump would look tidy and lose every login.
    const dataLine = dump.slice(dump.indexOf('-f "$out/data.sql"'));
    expect(dataLine.split("\n\n")[0]).not.toMatch(/(-s|--schema)\b/);
    expect(KEY_TABLES).toContain("auth.users");
    expect(MUST_NOT_BE_EMPTY).toEqual(expect.arrayContaining(["auth.users", "public.organizations"]));
  });

  it("leaves pg_net's outbox out, so a restore cannot re-send requests", () => {
    expect(dump).toMatch(/-x "net\.http_request_queue"/);
  });

  it("carries the cron schedule and email queues, which pg_dump skips", () => {
    // Found by dumping a database built from the migrations: cron.job and the
    // pgmq queue tables belong to extensions and came back empty-handed.
    expect(dump).toMatch(/format\('SELECT pgmq\.create\(%L\);', queue_name\) from pgmq\.meta/);
    expect(dump).toMatch(/format\('SELECT cron\.schedule\(%L, %L, %L\);', jobname, schedule, command\)/);
    expect(dump).toMatch(/copy-row-counts\.mjs" "\$out\/data\.sql" "\$out\/extension-state\.sql"/);
    expect(read("scripts/backup/crypt.sh")).toMatch(/roles\.sql schema\.sql data\.sql extension-state\.sql counts\.json/);
  });
});

describe("the drill restores and then actually checks", () => {
  it("runs after the backup, on the artifacts it made, through drill.sh", () => {
    expect(drill.needs).toBe("backup");
    const names = drill.steps.filter((s) => s.uses?.startsWith("actions/download-artifact")).map((s) => s.with?.name);
    expect(names.sort()).toEqual(["db-backup", "db-backup-summary"]);
    expect(drill.steps.some((s) => /scripts\/backup\/drill\.sh "\$archive" drill\/summary\/summary\.json/.test(s.run ?? ""))).toBe(true);
  });

  it("drill.sh checks the checksum, restores, and verifies against the summary", () => {
    const sh = read("scripts/backup/drill.sh");
    expect(sh).toMatch(/archive\.sha256/);
    expect(sh).toMatch(/restore\.sh" "\$opened" "\$db_url"/);
    expect(sh).toMatch(/verify-restore\.mjs" "\$opened" "\$db_url" \$\{summary:\+"\$summary"\}/);
  });

  it("compares every table's count exactly, and refuses a restore of nothing", () => {
    const v = read("scripts/backup/verify-restore.mjs");
    expect(v).toMatch(/got !== want/);
    expect(v).toMatch(/MUST_NOT_BE_EMPTY/);
    expect(v).toMatch(/no-orphans-after-restore\.sql/);
  });

  it("commits every restored cron job inactive, in the same transaction as the data", () => {
    const r = read("scripts/backup/restore.sh");
    const files = [...r.matchAll(/--file "([^"]+)"/g)].map((m) => m[1]);
    // roles, schema, data, then the cron schedule and queues pg_dump skips,
    // and LAST the switch-off -- after everything that can create a job.
    expect(files).toEqual([
      "$dir/roles.sql",
      "$dir/schema.sql",
      "$dir/data.sql",
      "$dir/extension-state.sql",
      "$here/disable-restored-cron-jobs.sql",
    ]);
    expect(r).toMatch(/--single-transaction/);
    // Through cron.alter_job: on Supabase `postgres` cannot UPDATE cron.job,
    // which a restore into a local stack proved.
    expect(read("scripts/backup/disable-restored-cron-jobs.sql")).toMatch(/cron\.alter_job\(j\.jobid, active := false\)/);
  });
});

describe("every backup script stops on the first error", () => {
  it.each(["dump.sh", "crypt.sh", "restore.sh", "drill.sh", "install-postgres-client.sh"])("%s", (f) => {
    expect(read(`scripts/backup/${f}`)).toMatch(/^#!\/usr\/bin\/env bash\n(#.*\n|\n)*set -euo pipefail$/m);
  });
});

describe("counting the rows a dump holds", () => {
  const dir = mkdtempSync(join(tmpdir(), "copy-rows-"));
  const write = (name: string, body: string) => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  it("counts one row per line, an empty table as zero, and ignores everything outside COPY", async () => {
    const p = write(
      "ok.sql",
      [
        "SET session_replication_role = replica;",
        'COPY "auth"."users" ("id", "email") FROM stdin;',
        "1\ta@example.test",
        // A newline inside a value is the two characters \n, so this is ONE row.
        "2\tline one\\nline two",
        // A value that is literally backslash-dot is escaped, not a terminator.
        "3\t\\\\.",
        "\\.",
        'COPY "public"."organizations" ("id") FROM stdin;',
        "\\.",
        'COPY "public"."we""ird" ("id") FROM stdin;',
        "x",
        "\\.",
        "SELECT pg_catalog.setval('\"public\".\"s\"', 3, true);",
        "RESET ALL;",
      ].join("\n") + "\n",
    );
    expect(await countCopyRows(p)).toEqual({
      "auth.users": 3,
      "public.organizations": 0,
      'public.we"ird': 1,
    });
  });

  it("counts cron jobs and queues by statement, not by line", async () => {
    const p = write(
      "ext.sql",
      [
        "-- generated",
        "SELECT pgmq.create('auth_emails');",
        "SELECT cron.schedule('weekly-digest', '0 13 * * 1', '",
        "  select net.http_post(url := ''https://example.test'');",
        "  ');",
        "SELECT cron.schedule('prune', '30 4 * * 0', 'SELECT 1;');",
      ].join("\n") + "\n",
    );
    expect(await countExtensionState(p)).toEqual({ "cron.job": 2, "pgmq.meta": 1 });
  });

  it("refuses a dump cut off inside a COPY block rather than reporting what it read", async () => {
    const p = write("cut.sql", 'COPY "public"."clients" ("id") FROM stdin;\n1\n2\n');
    await expect(countCopyRows(p)).rejects.toThrow(/truncated/);
  });
});
