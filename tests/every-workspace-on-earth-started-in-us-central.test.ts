/**
 * Nothing ever asked a new business what time zone it is in.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `organizations.timezone` is `NOT NULL DEFAULT 'America/Chicago'`, there is
 * no timezone field anywhere in signup, and `bootstrap_organization` inserted
 * without the column. So every workspace ever created started in US Central
 * and stayed there until somebody found Settings -> Preferences. An operator
 * in Michigan was an hour out; one in California three. Every workday window,
 * every optimized ETA, every "visits today" boundary and every month-to-date
 * cut was wrong by that much for a business that never chose anything.
 *
 * 20260805080000 fixed exactly one organization by hand -- "its timezone said
 * America/Chicago, so every optimized ETA was an hour out" -- without asking
 * why it said that.
 *
 * ── WHY A CHAIN TEST, AND NOT A UNIT TEST ─────────────────────────────────
 *
 * The fix is a value threaded through five links: the browser reads its zone,
 * the client passes it, the schema accepts it, the server function forwards it
 * as `_timezone`, and the SQL writes it. Break any ONE and the result is not
 * an error -- it is every new workspace landing in Central again, silently,
 * exactly as before. There is no screen that would look wrong and no test
 * that would go red; the only symptom is an ETA an hour out, months later,
 * for somebody who never knew the setting existed.
 *
 * That is the "built and unwired" class this repo already checks for, and it
 * is why the assertions below follow the value rather than testing any single
 * function.
 *
 * ── AND WHY IT STRIPS COMMENTS ────────────────────────────────────────────
 *
 * The rule "the signup path names no zone of its own" is broken by prose: the
 * helper added in ensure-workspace.ts EXPLAINS the bug by quoting
 * `'America/Chicago'`, and so does the handler's comment. A first version of
 * the check failed on the code that fixes the fault. That is the same false
 * match the accounting tab, `post_credit_entry`, `sandboxes.yml`,
 * `describePlatformFee()` and 20260911230000 hit -- the sixth time -- so
 * `codeOnly()` and its tripwire are not optional here.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * TypeScript with its comments removed, quote-aware so a `//` inside a string
 * (a URL, most often) survives. Lines are preserved so a failure can still say
 * where to look.
 */
export function codeOnly(ts: string): string {
  const noBlocks = ts.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  return noBlocks
    .split("\n")
    .map((line) => {
      let quote: string | null = null;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
          if (c === "\\") i++;
          else if (c === quote) quote = null;
        } else if (c === '"' || c === "'" || c === "`") {
          quote = c;
        } else if (c === "/" && line[i + 1] === "/") {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** The newest migration that defines bootstrap_organization. */
function bootstrapSql(): string {
  const dir = join(root, "supabase", "migrations");
  const hit = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .filter((f) =>
      /FUNCTION public\.bootstrap_organization\s*\(/.test(readFileSync(join(dir, f), "utf8")),
    )
    .pop();
  if (!hit) throw new Error("no migration defines bootstrap_organization");
  return readFileSync(join(dir, hit), "utf8");
}

/** Any IANA zone written as a literal, e.g. "America/Chicago". */
const IANA = /["']([A-Za-z]+\/[A-Za-z_]+)["']/g;

describe("the comment stripper this file rests on", () => {
  it("removes prose without removing code", () => {
    const raw = read("src/lib/ensure-workspace.ts");
    const code = codeOnly(raw);

    // The helper's doc comment quotes the default it exists to stop relying on.
    expect(raw).toContain("America/Chicago");
    expect(code).not.toContain("America/Chicago");

    // And the code around it is untouched.
    expect(code).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(code).toContain("timezone: browserTimezone()");
  });

  it("leaves a // inside a string alone", () => {
    expect(codeOnly('const u = "https://x.test"; // gone')).toBe('const u = "https://x.test"; ');
  });
});

describe("a new workspace is created in its own time zone", () => {
  it("the browser's zone is read at signup", () => {
    const code = codeOnly(read("src/lib/ensure-workspace.ts"));
    expect(code, "nothing reads the browser's IANA zone").toContain(
      "Intl.DateTimeFormat().resolvedOptions().timeZone",
    );
    // SSR has no zone and a hardened browser can throw. Either must degrade to
    // "unset" rather than to a guess or an exception during signup.
    expect(code).toMatch(/typeof window === "undefined"/);
    expect(code).toMatch(/catch\s*\{/);
  });

  it("the client hands it to bootstrapOrganization", () => {
    const code = codeOnly(read("src/lib/ensure-workspace.ts"));
    const call = code.slice(code.indexOf("await bootstrapOrganization("));
    expect(call, "the bootstrap call does not pass a timezone").toMatch(
      /timezone:\s*browserTimezone\(\)/,
    );
  });

  it("the server function accepts it and forwards it as _timezone", () => {
    const code = codeOnly(read("src/lib/org.functions.ts"));
    expect(code, "bootstrapSchema drops the field, so it never reaches the handler").toMatch(
      /timezone:\s*z\.string\(\)/,
    );
    const rpc = code.slice(code.indexOf('supabase.rpc("bootstrap_organization"'));
    expect(rpc, "the RPC call does not pass _timezone").toMatch(/_timezone:\s*data\.timezone/);
  });

  it("the SQL writes it, and only for a genuinely new organization", () => {
    const sql = bootstrapSql();
    expect(sql).toMatch(/_timezone text DEFAULT NULL/);

    // THE BODY, not the file. The migration's own establishes-block quotes
    // `SET timezone = _tz` in the string it searches prosrc for, so a check
    // against the whole file is satisfied by the assertion about the check --
    // this test passed with the write replaced by `NULL;` until it was scoped
    // here. Same false match as everywhere else in this file's header, one
    // level further in.
    const start = sql.indexOf("AS $function$");
    const body = sql.slice(start, sql.indexOf("$function$;", start));
    expect(body, "the parameter is accepted and never written").toMatch(/SET timezone = _tz/);

    // The early return for an existing owner is what makes the write
    // creation-time-only. Without it an idempotent re-run from a second
    // machine would overwrite a timezone its owner had since chosen.
    expect(body.indexOf("RETURN _existing;")).toBeLessThan(body.indexOf("SET timezone = _tz"));

    // An unrecognised zone must be dropped, never raised on: a browser string
    // cannot be allowed to block a signup.
    expect(body).toMatch(/pg_timezone_names/);
  });

  it("nothing on the signup path names a zone of its own", () => {
    // One written default, in the column. A second copy in the client or the
    // handler is how road_factor ended up with three answers (20260911230000).
    const offenders: string[] = [];
    for (const f of ["src/lib/ensure-workspace.ts", "src/lib/org.functions.ts"]) {
      codeOnly(read(f))
        .split("\n")
        .forEach((line, i) => {
          for (const m of line.matchAll(IANA)) offenders.push(`${f}:${i + 1}  ${m[1]}`);
        });
    }
    expect(
      offenders,
      `the signup path hardcodes a time zone:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
