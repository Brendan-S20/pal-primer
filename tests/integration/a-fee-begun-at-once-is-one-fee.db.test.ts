/** A fee begun at once is one fee, and no error (20261109163700).
 *
 *  begin_portal_change_fee inserted with `ON CONFLICT (request_id) DO
 *  NOTHING`, while portal_change_fee_charges also has a unique
 *  idempotency_key that always clashes with request_id. With one arbiter named,
 *  Postgres checks the other unique index the plain way, so two calls that
 *  pass the pre-check in the same instant end with one of them raising 23505
 *  on idempotency_key instead of returning the existing fee. CI saw it in
 *  a-portal-change-is-made-once.db.test.ts (job 129040645647).
 *
 *  That race cannot be forced with locks: both calls have to pass the
 *  pre-check before either inserts, so a lock that makes one wait for the
 *  other also makes it see the other's row and back out. It is forced here
 *  the only way it can be: six sessions held behind a barrier (an advisory
 *  lock) and released together, many rounds.
 *
 *  What runs is the LIVE function body, read from the database the job just
 *  replayed (pg_get_functiondef on this one named function), copied into a
 *  throwaway schema with its own copy of the fee table (LIKE ... INCLUDING ALL:
 *  the same unique indexes, defaults and checks) and a minimal requests table.
 *  The same body with the old line put back is the mutant, and it must
 *  reproduce the 23505, or this test proves nothing.
 *
 *  Runs where tests/run-db-tests.sh runs it (the database job). Skipped
 *  without TEST_SUPABASE_* env like every file here; with that env but
 *  without TEST_SUPABASE_DB_URL or psql it fails rather than skips. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { dbEnabled } from "../support/walk-db";

const PG_URL = process.env.TEST_SUPABASE_DB_URL;
const SCHEMA = `zz_fee_race_${Math.random().toString(36).slice(2, 8)}`;
const FIXED = `${SCHEMA}.begin_portal_change_fee`;
const MUTANT = `${SCHEMA}.begin_portal_change_fee_targeted`;
const LIVE_LINE = "ON CONFLICT DO NOTHING";
const OLD_LINE = "ON CONFLICT (request_id) DO NOTHING";

function ask(sql: string): string {
  const r = spawnSync(
    "psql",
    [PG_URL!, "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-c", sql],
    {
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  if (r.status !== 0) throw new Error(r.stderr || `psql exited ${r.status}`);
  return r.stdout.trim();
}

type Call = { code: number | null; out: string; err: string };

/** One round: a new request, six sessions behind a barrier, released together. */
async function round(fn: string): Promise<{ calls: Call[]; rows: number }> {
  const id = ask("SELECT gen_random_uuid()");
  ask(
    `INSERT INTO ${SCHEMA}.portal_change_requests VALUES ('${id}', gen_random_uuid(), gen_random_uuid(), 'applied', 1000)`,
  );
  const tag = `fee-race-${Math.random().toString(36).slice(2, 8)}`;
  const key = Math.floor(Math.random() * 2_000_000_000);
  // The barrier: an exclusive advisory lock this session holds until all six
  // are waiting on it.
  const barrier = spawn("psql", [PG_URL!, "-X", "-A", "-t", "-q"], {
    env: { ...process.env, PGAPPNAME: `${tag}-barrier` },
  });
  barrier.stdin.write(`SELECT pg_advisory_lock(${key});\n\\echo LOCKED\n`);
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("barrier never locked")), 15_000);
    barrier.stdout.on("data", (d) => {
      if (String(d).includes("LOCKED")) {
        clearTimeout(t);
        resolve();
      }
    });
  });
  const racers = Array.from(
    { length: 6 },
    () =>
      new Promise<Call>((resolve) => {
        const c = spawn(
          "psql",
          [
            PG_URL!,
            "-X",
            "-A",
            "-t",
            "-q",
            "-v",
            "ON_ERROR_STOP=1",
            "-c",
            `SELECT pg_advisory_lock_shared(${key}); SELECT pg_advisory_unlock_shared(${key}); SELECT ${fn}('${id}')->>'created';`,
          ],
          { env: { ...process.env, PGAPPNAME: tag } },
        );
        const killer = setTimeout(() => c.kill("SIGKILL"), 20_000);
        let out = "";
        let err = "";
        c.stdout.on("data", (d) => (out += d));
        c.stderr.on("data", (d) => (err += d));
        c.on("close", (code) => {
          clearTimeout(killer);
          // psql prints each statement's result; the call's is the last line.
          resolve({ code, out: out.trim().split("\n").pop() ?? "", err });
        });
      }),
  );
  // Release only once all six are waiting on the barrier.
  for (let t = 0; t < 500; t++) {
    const waiting = ask(
      `SELECT count(*) FROM pg_stat_activity WHERE application_name = '${tag}' AND wait_event_type = 'Lock'`,
    );
    if (waiting === "6") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  barrier.stdin.end(`SELECT pg_advisory_unlock(${key});\n`);
  const calls = await Promise.all(racers);
  const rows = Number(
    ask(`SELECT count(*) FROM ${SCHEMA}.portal_change_fee_charges WHERE request_id = '${id}'`),
  );
  return { calls, rows };
}

describe.skipIf(!dbEnabled)("a fee begun at once is one fee, and no error", () => {
  beforeAll(() => {
    expect(PG_URL, "TEST_SUPABASE_DB_URL (tests/run-db-tests.sh exports it)").toBeTruthy();
    expect(spawnSync("psql", ["--version"]).status, "psql").toBe(0);
    const live = ask(
      "SELECT pg_get_functiondef('public.begin_portal_change_fee(uuid)'::regprocedure)",
    );
    // The replayed database carries 20261109163700's body.
    expect(live).toContain(LIVE_LINE);
    expect(live).not.toContain(OLD_LINE);
    const inSchema = (src: string, name: string) =>
      src
        .replace("FUNCTION public.begin_portal_change_fee(", `FUNCTION ${name}(`)
        .replaceAll("public.portal_change_requests", `${SCHEMA}.portal_change_requests`)
        .replaceAll("public.portal_change_fee_charges", `${SCHEMA}.portal_change_fee_charges`)
        .replace(
          "SET search_path TO 'public', 'pg_temp'",
          `SET search_path TO '${SCHEMA}', 'pg_temp'`,
        );
    const fixed = inSchema(live, FIXED);
    const mutant = inSchema(live.replace(LIVE_LINE, OLD_LINE), MUTANT);
    expect(fixed).not.toMatch(/public\.portal_change_/);
    expect(mutant).toContain(OLD_LINE);
    ask(`CREATE SCHEMA ${SCHEMA}`);
    // The columns the function reads from a request, and nothing else.
    ask(
      `CREATE TABLE ${SCHEMA}.portal_change_requests (id uuid PRIMARY KEY, organization_id uuid, client_id uuid, status text, fee_cents integer)`,
    );
    // The real fee table's shape: its unique indexes are the point.
    ask(
      `CREATE TABLE ${SCHEMA}.portal_change_fee_charges (LIKE public.portal_change_fee_charges INCLUDING ALL)`,
    );
    const uniques = ask(
      `SELECT string_agg(indexdef, ' | ') FROM pg_indexes WHERE schemaname = '${SCHEMA}' AND tablename = 'portal_change_fee_charges' AND indexdef LIKE 'CREATE UNIQUE%'`,
    );
    expect(uniques).toContain("(request_id)");
    expect(uniques).toContain("(idempotency_key)");
    ask(fixed);
    ask(mutant);
  });

  afterAll(() => {
    if (PG_URL && dbEnabled) ask(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  it("mutation: with the targeted ON CONFLICT, a call raises 23505 on idempotency_key", async () => {
    let raised: Call | undefined;
    for (let i = 0; i < 60 && !raised; i++) {
      const { calls, rows } = await round(MUTANT);
      expect(rows, "the data is right even here: one fee row").toBe(1);
      raised = calls.find((c) => c.code !== 0);
    }
    // If this never reproduces, the next case proves nothing.
    expect(raised?.err ?? "never reproduced in 60 rounds").toMatch(
      /duplicate key value violates unique constraint "[^"]*idempotency_key_key"/,
    );
  }, 240_000);

  it("the live function: six at once, forty times, every call answers and there is one fee", async () => {
    for (let i = 0; i < 40; i++) {
      const { calls, rows } = await round(FIXED);
      const failed = calls.filter((c) => c.code !== 0);
      expect(
        failed.map((c) => c.err),
        `round ${i}`,
      ).toEqual([]);
      expect(
        calls.filter((c) => c.out === "true"),
        `round ${i}: created once`,
      ).toHaveLength(1);
      expect(rows, `round ${i}: one fee row`).toBe(1);
    }
  }, 240_000);
});
