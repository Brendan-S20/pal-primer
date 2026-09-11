/**
 * One detour factor, spelled four ways.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `organizations.road_factor` is road km per straight-line km. On 2026-09-11
 * this database held two answers -- 1.45 on Demo Pet Waste Co and 1.30 on the
 * other five -- against a measured median of 1.354 from 3,168 OSRM legs. The
 * 1.45 was a Manhattan leftover, set by the same UPDATE as the `dense_urban`
 * that 20260911200000 undid.
 *
 * Fixing the rows alone would not have fixed it. The column DEFAULT was 1.30,
 * so the next organization to sign up would have disagreed with every row
 * already there, and the argument restarts with nobody watching. And the
 * estimators carry a third spelling of their own -- `COALESCE(
 * measured_road_factor, road_factor, 1.30)`, once in drive_minutes and twice
 * in road_km -- which would then have disagreed with both.
 *
 * So this pins the two couplings that a migration can silently break:
 *
 *   1. every road-factor fallback literal equals the DEFAULT in force at that
 *      point in the sequence, and
 *   2. a migration that moves the DEFAULT also re-costs the rows already
 *      there, so old and new organizations cannot drift apart.
 *
 * ── WHY IT STRIPS COMMENTS FIRST, AND HOW THAT WAS PROVED NECESSARY ───────
 *
 * The first version of this file failed on the very migration that fixes the
 * bug. `20260911230000` explains itself by QUOTING the expression it is
 * replacing, so the string `COALESCE(measured_road_factor, road_factor, 1.30)`
 * appears twice in its header prose while the code below says 1.35. A rule
 * about SQL must not be satisfiable -- or breakable -- by English about SQL.
 *
 * That is the fourth time this repo has been bitten by the same thing: the
 * accounting tab's two ternary branches, `post_credit_entry` reading its own
 * comment out of prosrc, `sandboxes.yml` naming a removed `if:` in the comment
 * removing it, and `describePlatformFee()` named in the comment above its
 * handler. Hence `codeOnly()`, and hence the tripwire below it, which fails if
 * stripping ever stops working -- because a stripper that returns nothing at
 * all would make every assertion here vacuously true.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dirname, "..", "supabase", "migrations");
const files = () =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
const read = (f: string) => readFileSync(join(dir, f), "utf8");

/**
 * SQL with its `--` comments removed, quote-aware so that a `--` inside a
 * string literal survives. Line numbers are preserved: every line stays a
 * line, so a failure can still name where to go and look.
 */
export function codeOnly(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      let quoted = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === "'") quoted = !quoted;
        else if (!quoted && line[i] === "-" && line[i + 1] === "-") return line.slice(0, i);
      }
      return line;
    })
    .join("\n");
}

/** A decimal literal, e.g. "1.35". Integers are not road factors. */
const DECIMAL = /^\d+\.\d+$/;

/**
 * Every `COALESCE(...)` in the file whose arguments are about a road factor,
 * paired with its final argument. The argument lists in question hold no
 * nested parentheses, which is what lets this stay a regex.
 */
function roadFactorFallbacks(code: string): { line: number; literal: string; text: string }[] {
  const out: { line: number; literal: string; text: string }[] = [];
  code.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/COALESCE\(([^()]*)\)/gi)) {
      const args = m[1].split(",").map((a) => a.trim());
      const mentionsRoadFactor = args.some(
        (a) => /(^|\.|_)road_factor$/i.test(a) || /^_factor$/i.test(a),
      );
      if (!mentionsRoadFactor) continue;
      const last = args[args.length - 1];
      if (!DECIMAL.test(last)) continue;
      out.push({ line: i + 1, literal: last, text: m[0] });
    }
  });
  return out;
}

/** Where the file moves the column default, if it does. */
function defaultsSet(code: string): { line: number; literal: string }[] {
  const out: { line: number; literal: string }[] = [];
  code.split("\n").forEach((line, i) => {
    const m =
      line.match(/road_factor\s+numeric[^,;]*DEFAULT\s+(\d+\.\d+)/i) ??
      line.match(/ALTER\s+COLUMN\s+road_factor\s+SET\s+DEFAULT\s+(\d+\.\d+)/i);
    if (m) out.push({ line: i + 1, literal: m[1] });
  });
  return out;
}

describe("the comment stripper this file rests on", () => {
  it("removes prose without removing code", () => {
    const raw = read("20260911230000_three-organizations-three-answers-to-one-question.sql");
    const code = codeOnly(raw);

    // The header quotes the OLD expression. That is the false match.
    expect(raw).toContain("COALESCE(measured_road_factor, road_factor, 1.30)");
    expect(code).not.toContain("COALESCE(measured_road_factor, road_factor, 1.30)");

    // And the code it is wrapped around is still there.
    expect(code).toContain("ALTER COLUMN road_factor SET DEFAULT 1.35");
    expect(code).toContain("COALESCE(_o.measured_road_factor, _o.road_factor, 1.35)");

    // The one surviving mention of the old value is the migration's own
    // assertion that no estimator still contains it, which is code and must
    // not be stripped.
    expect(code).toContain("p.prosrc LIKE '%1.30%'");

    // What matters is that no FALLBACK still reads 1.30.
    expect(roadFactorFallbacks(code).map((c) => c.literal)).toEqual(["1.35", "1.35", "1.35"]);
  });

  it("leaves a -- inside a string literal alone", () => {
    expect(codeOnly("SELECT 'a -- b'; -- gone")).toBe("SELECT 'a -- b'; ");
  });

  it("finds the fallbacks and the defaults it is supposed to find", () => {
    // Without this, a regex that silently matched nothing would make every
    // assertion below pass on any repo at all.
    const code = codeOnly(read("20260903090000_thirty-was-both-the-default-and-a-real-answer.sql"));
    expect(roadFactorFallbacks(code)).toHaveLength(3);
    expect(
      defaultsSet(
        codeOnly(read("20260805080000_a-straight-line-mile-is-not-a-mile-of-driving.sql")),
      ),
    ).toHaveLength(1);
  });
});

describe("one road factor", () => {
  it("every fallback literal equals the default in force where it is written", () => {
    let current: { literal: string; file: string } | null = null;
    const wrong: string[] = [];

    for (const f of files()) {
      const code = codeOnly(read(f));
      for (const d of defaultsSet(code)) current = { literal: d.literal, file: f };
      for (const c of roadFactorFallbacks(code)) {
        if (!current) {
          wrong.push(
            `${f}:${c.line}  ${c.text} falls back to ${c.literal} before any default is set`,
          );
        } else if (Number(c.literal) !== Number(current.literal)) {
          wrong.push(
            `${f}:${c.line}  ${c.text} falls back to ${c.literal}, but the column default is ` +
              `${current.literal} (set in ${current.file})`,
          );
        }
      }
    }

    expect(wrong, `a road factor is spelled two ways:\n  ${wrong.join("\n  ")}`).toEqual([]);
    expect(current?.literal).toBeDefined();
  });

  it("a migration that moves the default also re-costs the rows already there", () => {
    const wrong: string[] = [];

    for (const f of files()) {
      const code = codeOnly(read(f));
      for (const d of defaultsSet(code)) {
        // ADD COLUMN ... DEFAULT writes every existing row itself; only a
        // later ALTER leaves the rows behind.
        if (!/ALTER\s+COLUMN\s+road_factor\s+SET\s+DEFAULT/i.test(code)) continue;

        const recosts = new RegExp(
          String.raw`UPDATE\s+public\.organizations\s+SET\s+road_factor\s*=\s*${d.literal.replace(".", "\\.")}\b`,
          "i",
        ).test(code.replace(/\s+/g, " "));

        if (!recosts) {
          wrong.push(
            `${f}:${d.line}  moves the default to ${d.literal} but never brings the existing ` +
              `rows to it, so organizations created before and after this file disagree`,
          );
        }
      }
    }

    expect(wrong, `a default moved without the rows:\n  ${wrong.join("\n  ")}`).toEqual([]);
  });
});
