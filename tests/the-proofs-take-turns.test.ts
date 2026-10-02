// Every SQL proof takes one shared lock before it touches anything.
//
// Each tests/sql/*.proof.sql applies its migration inside a transaction and
// rolls it back. Applying a migration takes ACCESS EXCLUSIVE locks on the
// tables it alters -- organizations, visits, invoices -- and vitest runs the
// wrappers in parallel, so two proofs altering the same two tables in a
// different order deadlock. On 2026-10-02 PR #294 failed twice running on
// exactly that: four proofs, "deadlock detected ... waits for
// AccessExclusiveLock on relation 18519", none of them about #294.
//
// A deadlock-only retry (the-demo-was-paid-next-week.test.ts) fixes one
// wrapper; this fixes the class. A session-level advisory lock, taken first
// and held until psql disconnects, makes the proofs queue instead of collide.
// The wrappers allow 300 s so a proof waiting its turn on a loaded runner is
// not mistaken for a hung one.
//
// What this checks: the lock is there, and nothing but psql settings comes
// before it -- a BEGIN or an \i above it would take table locks unqueued.
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SQL_DIR = join(import.meta.dirname, "sql");
const LOCK =
  /^DO \$turn\$ BEGIN PERFORM pg_advisory_lock\(hashtext\('houndstack\.proof'\)\); END \$turn\$;$/;
const MAY_PRECEDE = /^(\\set\b|SET\s+\w+\s+TO\b)/i;

const proofs = readdirSync(SQL_DIR).filter((f) => f.endsWith(".proof.sql"));

describe("the proofs take turns", () => {
  it("has proofs to check", () => {
    expect(proofs.length).toBeGreaterThan(0);
  });

  it.each(proofs)("%s takes the shared lock before anything else", (file) => {
    const lines = readFileSync(join(SQL_DIR, file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("--"));
    const at = lines.findIndex((l) => LOCK.test(l));
    expect(
      at,
      `${file} never takes the proof lock — add the DO $turn$ line after the \\set/SET header`,
    ).toBeGreaterThanOrEqual(0);
    const before = lines.slice(0, at).filter((l) => !MAY_PRECEDE.test(l));
    expect(before, `${file} runs this before taking the proof lock`).toEqual([]);
  });

  // Waiting its turn is time vitest counts. psql was given 300 s, but the
  // test around it kept vitest's 30 s default, so on 2026-10-02 (swap 96%
  // full, load 38) nothing-could-listen-for-a-completed-visit "timed out in
  // 30000ms" while the proof itself was fine. Every file that runs a proof
  // gives its tests the same 300 s.
  const TESTS_DIR = join(import.meta.dirname);
  const wrappers = readdirSync(TESTS_DIR).filter((f) => {
    if (!f.endsWith(".test.ts") || f === "the-proofs-take-turns.test.ts") return false;
    const src = readFileSync(join(TESTS_DIR, f), "utf8");
    return src.includes(".proof.sql") && src.includes("spawnSync");
  });

  it("has proof wrappers to check", () => {
    expect(wrappers.length).toBeGreaterThan(0);
  });

  it.each(wrappers)("%s gives a proof waiting its turn 300 s, not vitest's 30", (file) => {
    const src = readFileSync(join(TESTS_DIR, file), "utf8");
    expect(src, `${file}: add vi.setConfig({ testTimeout: 300_000 }) after the imports`).toMatch(
      /vi\.setConfig\(\{ testTimeout: 300_000 \}\);/,
    );
  });
});
