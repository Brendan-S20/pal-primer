// #608: the groomer's skip picker offered pet_not_ready, client_not_home,
// no_parking and pet_stressed. The database enum had all four
// (20261024100700_grooming-skip-reasons.sql), but skipVisit validated against
// its own copy of the yard list, so every grooming reason was refused and the
// tech saw the validator's JSON in a toast.
//
// The pickers, the validator and the database enum are now one list. This
// pins that they stay one: a reason added to a picker is accepted by the
// server, and a reason the server accepts is a value Postgres can store.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FIELD_SKIP_REASON_CODES,
  GROOM_SKIP_REASON_CODES,
  SKIP_REASON_CODES,
  techSkipReasonCodes,
} from "@/lib/skip-rules.functions";
import { skipVisitInput } from "@/lib/my-day.functions";
import { Constants } from "@/integrations/supabase/types";
import { readableError } from "@/lib/readable-error";

const migrationsDir = new URL("../supabase/migrations/", import.meta.url);
const migrations = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((f) => ({ file: f, sql: readFileSync(new URL(f, migrationsDir), "utf8") }));

/** The skip_reason_code enum a replay of every migration builds. */
function replayedEnum(): Set<string> {
  const values = new Set<string>();
  for (const { sql } of migrations) {
    const created = sql.match(/CREATE TYPE public\.skip_reason_code AS ENUM \(([^)]*)\)/);
    if (created) for (const m of created[1].matchAll(/'([a-z_]+)'/g)) values.add(m[1]);
    for (const m of sql.matchAll(
      /ALTER TYPE public\.skip_reason_code ADD VALUE(?: IF NOT EXISTS)? '([a-z_]+)'/g,
    ))
      values.add(m[1]);
  }
  return values;
}

const LINES = [
  undefined,
  "pet_waste",
  "dog_walking",
  "pet_sitting",
  "training",
  "mobile_grooming",
] as const;

const validatorCodes = () => skipVisitInput.shape.code.removeDefault().options as readonly string[];
const sorted = (xs: Iterable<string>) => [...xs].sort();

describe("one list of skip reasons", () => {
  it("the pickers on every service line offer exactly what skipVisit accepts", () => {
    const offered = new Set(LINES.flatMap((l) => [...techSkipReasonCodes(l)]));
    expect(sorted(offered)).toEqual(sorted(FIELD_SKIP_REASON_CODES));
    expect(sorted(validatorCodes())).toEqual(sorted(FIELD_SKIP_REASON_CODES));
  });

  it("the schedule's codes are the database enum, by replay and by generated types", () => {
    expect(sorted(replayedEnum())).toEqual(sorted(SKIP_REASON_CODES));
    expect(sorted(Constants.public.Enums.skip_reason_code)).toEqual(sorted(SKIP_REASON_CODES));
  });

  it("a tech can use every schedule code but the one only the portal writes", () => {
    expect(sorted(SKIP_REASON_CODES.filter((c) => !FIELD_SKIP_REASON_CODES.includes(c)))).toEqual([
      "customer_requested",
    ]);
  });
});

describe("each grooming reason saves its own code", () => {
  const visitId = "00000000-0000-4000-8000-000000000001";

  it.each([...GROOM_SKIP_REASON_CODES])("%s passes the validator unchanged", (code) => {
    const parsed = skipVisitInput.parse({ visitId, reason: "Pet hid under the bed", code });
    expect(parsed.code).toBe(code);
  });

  it("a code no picker offers is still refused", () => {
    expect(() =>
      skipVisitInput.parse({ visitId, reason: "x", code: "customer_requested" }),
    ).toThrow();
  });

  it("skip_visit stores the code and bills the skip rule's percent for it", () => {
    const latest = migrations.filter(({ sql }) =>
      /CREATE (OR REPLACE )?FUNCTION public\.skip_visit\(/.test(sql),
    );
    const sql = latest[latest.length - 1].sql;
    const body = sql.slice(sql.search(/CREATE (OR REPLACE )?FUNCTION public\.skip_visit\(/));
    expect(body).toMatch(/FROM public\.skip_billing_rules[\s\S]*reason_code = _code/);
    expect(body).toMatch(/_pct := public\.default_skip_billable_pct\(_code\)/);
    expect(body).toMatch(/skip_reason_code = _code/);
    expect(body).toMatch(/skip_charge_cents = _charge/);
  });
});

describe("a refused save reads as words", () => {
  it("turns the validator's issue list into the fallback", () => {
    const zodJson = JSON.stringify([
      { code: "invalid_enum_value", path: ["code"], message: "Invalid enum value" },
    ]);
    expect(readableError(new Error(zodJson), "This skip did not save.")).toBe(
      "This skip did not save.",
    );
  });

  it("keeps a message the product wrote", () => {
    expect(readableError(new Error("Visit is already completed"), "fallback")).toBe(
      "Visit is already completed",
    );
    expect(readableError(new Error(""), "fallback")).toBe("fallback");
  });
});
