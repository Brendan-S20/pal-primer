// One switch decides which service lines are bookable (#531).
//
// Until 20261025200000 the list was written down twice: BOOKABLE_SERVICE_LINES
// in src/lib/service-lines.ts and a constant array in
// public.bookable_service_lines(), and this file held the two equal. Now the
// answer is one table, public.platform_service_lines, read at runtime, so
// this file holds the other half of that: the table's seed is the list as it
// is on main (pet waste and, since #530, walking), every SQL reader reads the table, and nothing in src/ writes
// the list down again.
//
// The SQL is read from the LAST migration that defines each function or
// seeds the table, so a later migration that re-creates one is the one
// checked. supabase/proofs/20261025200000-one-switch-decides-what-is-bookable.sql
// is the behaviour, against a real database: who can change it, the audit
// row, and the organizations gate following the switch.
//
// A launch after the seed is an UPDATE of one row in a later migration
// (pet sitting, #547: 20261026200000; training, #548: 20261027120000; mobile
// grooming, #549: 20261027180000), never an edit of the seed, so what a
// replay ends on is the seed with those UPDATEs applied in filename order.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SERVICE_LINES } from "@/lib/service-lines";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";
import { repoRelative, toPosix } from "./support/repo-paths";
import { LAUNCH_DEFAULT } from "./support/service-line-availability";

const ROOT = join(import.meta.dirname, "..");
const GUARD = "20261017004000_a-service-line-is-turned-on-only-when-bookable.sql";
const SWITCH = "20261025200000_one-switch-decides-what-is-bookable.sql";
const SITTING = "20261026200000_pet-sitting-is-bookable.sql";
const TRAINING = "20261027120000_training-is-bookable.sql";
const GROOMING = "20261027180000_mobile-grooming-is-bookable.sql";

function lastMatch(re: RegExp): { file: string; m: RegExpExecArray } | null {
  let found: { file: string; m: RegExpExecArray } | null = null;
  for (const file of migrationFiles()) {
    const m = re.exec(stripLineComments(readMigration(file)));
    if (m) found = { file, m };
  }
  return found;
}

function seed(): { line: string; bookable: boolean; requestable: boolean }[] {
  const found = lastMatch(
    /INSERT\s+INTO\s+public\.platform_service_lines\s*\(\s*service_line\s*,\s*bookable\s*,\s*customer_requestable\s*\)\s*VALUES([\s\S]*?)ON\s+CONFLICT/i,
  );
  if (!found) return [];
  return [
    ...found.m[1].matchAll(/\(\s*'([a-z_]+)'\s*,\s*(true|false)\s*,\s*(true|false)\s*\)/g),
  ].map((r) => ({ line: r[1], bookable: r[2] === "true", requestable: r[3] === "true" }));
}

type Row = { line: string; bookable: boolean; requestable: boolean };

/** Every `UPDATE public.platform_service_lines SET ... WHERE service_line =
 *  '...'` after the seed, in filename order. */
function flips(): { file: string; line: string; set: Partial<Omit<Row, "line">> }[] {
  const files = migrationFiles();
  const out: { file: string; line: string; set: Partial<Omit<Row, "line">> }[] = [];
  for (const file of files.slice(files.indexOf(SWITCH) + 1)) {
    const sql = stripLineComments(readMigration(file));
    for (const m of sql.matchAll(
      /UPDATE\s+public\.platform_service_lines\s+SET\s+([\s\S]*?)\s+WHERE\s+service_line\s*=\s*'([a-z_]+)'/gi,
    )) {
      const set: Partial<Omit<Row, "line">> = {};
      for (const a of m[1].matchAll(/\b(bookable|customer_requestable)\s*=\s*(true|false)\b/gi)) {
        if (a[1].toLowerCase() === "bookable") set.bookable = a[2] === "true";
        else set.requestable = a[2] === "true";
      }
      out.push({ file, line: m[2], set });
    }
  }
  return out;
}

/** The switch as a replay of every migration leaves it. */
function replayed(): Row[] {
  const rows = seed().map((r) => ({ ...r }));
  for (const f of flips()) {
    const row = rows.find((r) => r.line === f.line);
    if (row) Object.assign(row, f.set);
  }
  return rows;
}

function functionBody(name: string): string | null {
  const found = lastMatch(
    new RegExp(
      `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(\\s*\\)[\\s\\S]*?\\$function\\$([\\s\\S]*?)\\$function\\$`,
      "i",
    ),
  );
  return found ? found.m[1] : null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

describe("one switch decides which service lines are bookable", () => {
  it("seeds a row for every line the database accepts, and nothing else", () => {
    expect(
      seed()
        .map((r) => r.line)
        .sort(),
    ).toEqual([...SERVICE_LINES].sort());
  });

  it("seeds the list as it is on main after #530 and #535: pet waste and walking bookable, grooming and training not requestable", () => {
    const rows = seed();
    expect(rows.filter((r) => r.bookable).map((r) => r.line)).toEqual(["pet_waste", "dog_walking"]);
    expect(rows.filter((r) => !r.requestable).map((r) => r.line)).toEqual([
      "mobile_grooming",
      "training",
    ]);
  });

  it("comes after the #530 flip, so the table is what a replay ends on", () => {
    const files = migrationFiles();
    const flip = files.indexOf("20261024230000_dog-walking-is-bookable.sql");
    expect(flip).toBeGreaterThanOrEqual(0);
    expect(files.indexOf(SWITCH)).toBeGreaterThan(flip);
  });

  it("mobile grooming is bookable (#549): a replay ends on pet waste, walking, sitting, training and grooming, and nothing else", () => {
    const rows = replayed();
    expect(
      rows
        .filter((r) => r.bookable)
        .map((r) => r.line)
        .sort(),
    ).toEqual(["dog_walking", "mobile_grooming", "pet_sitting", "pet_waste", "training"]);
    // Customers may ask for a priced stay: the seed's true is left alone.
    expect(rows.find((r) => r.line === "pet_sitting")?.requestable).toBe(true);
    // A client may ask for a groom from the portal; the office books it.
    expect(rows.find((r) => r.line === "mobile_grooming")?.requestable).toBe(true);
    // Training is sold by the office: the seed's false is left alone.
    expect(rows.find((r) => r.line === "training")?.requestable).toBe(false);
  });

  it("a replay ends on exactly these customer-requestable lines, grooming in and training out", () => {
    expect(
      replayed()
        .filter((r) => r.requestable)
        .map((r) => r.line)
        .sort(),
    ).toEqual(["dog_walking", "mobile_grooming", "other", "pet_sitting", "pet_waste"]);
  });

  it("flips sitting in its own migration, after the switch, touching one row and one column", () => {
    const files = migrationFiles();
    expect(files.indexOf(SITTING)).toBeGreaterThan(files.indexOf(SWITCH));
    expect(flips().filter((f) => f.file === SITTING)).toEqual([
      { file: SITTING, line: "pet_sitting", set: { bookable: true } },
    ]);
  });

  it("flips training in its own migration, after sitting, touching one row and one column", () => {
    const files = migrationFiles();
    expect(files.indexOf(TRAINING)).toBeGreaterThan(files.indexOf(SITTING));
    expect(flips().filter((f) => f.file === TRAINING)).toEqual([
      { file: TRAINING, line: "training", set: { bookable: true } },
    ]);
  });

  it("flips grooming in its own migration, after training, touching one row and both columns", () => {
    const files = migrationFiles();
    expect(files.indexOf(GROOMING)).toBeGreaterThan(files.indexOf(TRAINING));
    expect(files.indexOf(GROOMING)).toBeGreaterThan(
      files.indexOf("20261027130000_a-dispatcher-books-a-sold-package.sql"),
    );
    expect(flips().filter((f) => f.file === GROOMING)).toEqual([
      { file: GROOMING, line: "mobile_grooming", set: { bookable: true, requestable: true } },
    ]);
    // No other file after the switch touches the grooming row.
    expect(
      flips()
        .filter((f) => f.line === "mobile_grooming")
        .map((f) => f.file),
    ).toEqual([GROOMING]);
  });

  it("is the default the TS fixtures drive the rules with", () => {
    const rows = replayed();
    expect(
      rows
        .filter((r) => r.bookable)
        .map((r) => r.line)
        .sort(),
    ).toEqual([...LAUNCH_DEFAULT.bookable].sort());
    expect(
      rows
        .filter((r) => r.requestable)
        .map((r) => r.line)
        .sort(),
    ).toEqual([...LAUNCH_DEFAULT.customerRequestable].sort());
  });

  it("never overwrites a switch a platform admin already flipped", () => {
    const sql = stripLineComments(readMigration(SWITCH));
    expect(sql).toMatch(/ON CONFLICT \(service_line\) DO NOTHING;/);
  });

  it("reads the table in bookable_service_lines() and customer_requestable_service_lines(), with no constant left", () => {
    for (const name of ["bookable_service_lines", "customer_requestable_service_lines"]) {
      const body = functionBody(name);
      expect(body, name).not.toBeNull();
      expect(body!, name).toMatch(/FROM\s+public\.platform_service_lines/);
      expect(body!, name).not.toMatch(/ARRAY\s*\[/i);
    }
  });

  it("lets no client role change it", () => {
    const sql = stripLineComments(readMigration(SWITCH));
    expect(sql).toMatch(
      /REVOKE ALL ON TABLE public\.platform_service_lines FROM PUBLIC, anon, authenticated;/,
    );
    expect(sql).toMatch(
      /GRANT SELECT, INSERT, UPDATE ON public\.platform_service_lines TO service_role;/,
    );
    expect(sql).not.toMatch(
      /GRANT[^;]*ON (?:TABLE )?public\.platform_service_lines TO[^;]*\b(?:anon|authenticated)\b/,
    );
    expect(sql).toMatch(/SELECT public\.require_mfa_policy\('public\.platform_service_lines'\);/);
    expect(sql).toMatch(
      /IF NOT \(auth\.role\(\) = 'service_role' OR public\.is_platform_admin\(auth\.uid\(\)\)\) THEN/,
    );
    expect(sql).toMatch(/INSERT INTO public\.platform_admin_audit/);
  });

  it("guards inserts and service_lines updates on organizations, and lets the service role through", () => {
    const sql = stripLineComments(readMigration(GUARD));
    expect(sql).toMatch(
      /CREATE TRIGGER organizations_service_lines_bookable\s+BEFORE INSERT OR UPDATE OF service_lines ON public\.organizations/,
    );
    expect(sql).toMatch(/auth\.role\(\) = 'service_role'/);
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.tg_orgs_service_lines_bookable\(\) FROM PUBLIC, anon, authenticated;/,
    );
  });

  it("writes the list down nowhere in src/", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(join(ROOT, "src"))) {
      const rel = toPosix(repoRelative(file, ROOT));
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((text, i) => {
        if (/\bBOOKABLE_SERVICE_LINES\b/.test(text)) offenders.push(`${rel}:${i + 1}`);
        // customerCanRequestService used to be `line !== "training"`.
        if (/customerCanRequestService[\s\S]*["'](?:training|pet_waste)["']/.test(text))
          offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it("reads the switch on the server through one loader", () => {
    const loader = readFileSync(join(ROOT, "src/lib/service-line-availability.server.ts"), "utf8");
    expect(loader).toMatch(/\.rpc\("service_line_availability"\)/);
    const callers = sourceFiles(join(ROOT, "src")).filter((f) =>
      /service_line_availability"/.test(readFileSync(f, "utf8")),
    );
    expect(callers.map((f) => toPosix(repoRelative(f, ROOT)))).toEqual([
      "src/lib/service-line-availability.server.ts",
    ]);
  });
});
