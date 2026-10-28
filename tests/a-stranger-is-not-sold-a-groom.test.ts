// A stranger is not sold a groom (#559).
//
// OFFICE_BOOKED_LINES in src/lib/service-lines.ts keeps grooming out of every
// customer door the app draws (customerCanBookService). public_services and
// public_quote, which the publishable key reaches directly, had no equivalent
// once #549 put mobile_grooming on both switches, so anon could list grooms
// and price one. 20261027200000 adds public.office_booked_service_lines(), the
// SQL copy of the list, and splices it into both functions.
//
// Two copies of a list is the setup for drift, so this file holds them equal:
// the array in the LAST migration that defines the function must be
// OFFICE_BOOKED_LINES. And because the filter this file replaces was lost
// once already (20261024100200 left grooming out of public_services, and
// 20261024100900 restated the function the same day without it), any later
// migration that restates either function must carry the filter too.
//
// Since 20261028120000 (#560) the booking link sells a groom: it prices one
// per pet size with the line's add-ons and takes it as a request. So the
// filter is spliced back OUT of public_services and public_quote, and the
// list stays as the app's copy for the portal one-off and the receptionist.
// supabase/proofs/20261028120000-the-booking-link-sells-every-live-line.sql
// is that behaviour against a real database, and replaces this file's
// earlier proof, which held the rule Brendan reversed.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { OFFICE_BOOKED_LINES, customerCanBookService } from "@/lib/service-lines";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";
import { LAUNCH_DEFAULT } from "./support/service-line-availability";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = "20261027200000_a-stranger-is-not-sold-a-groom.sql";
const LATER = "20261028120000_the-booking-link-sells-every-live-line.sql";
const PROOF = "supabase/proofs/20261028120000-the-booking-link-sells-every-live-line.sql";
const FILTER = "s.service_line <> ALL (public.office_booked_service_lines())";

const code = (file: string) => stripLineComments(readMigration(file));

/** The body of `CREATE [OR REPLACE] FUNCTION public.<name>(` in this SQL, from
 *  the CREATE to the closing dollar tag, or null. */
function functionBody(sql: string, name: string): string | null {
  const start = sql.search(
    new RegExp(`CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+public\\.${name}\\s*\\(`, "i"),
  );
  if (start < 0) return null;
  const tag = /AS\s+(\$\w*\$)/.exec(sql.slice(start));
  if (!tag) return null;
  const open = start + tag.index + tag[0].length;
  const close = sql.indexOf(tag[1], open);
  return close < 0 ? null : sql.slice(start, close);
}

describe("the database keeps the app's office-booked list", () => {
  it("is the same list as OFFICE_BOOKED_LINES, in the last migration that defines it", () => {
    let last: { file: string; body: string } | null = null;
    for (const file of migrationFiles()) {
      const body = functionBody(code(file), "office_booked_service_lines");
      if (body) last = { file, body };
    }
    expect(last?.file).toBeDefined();
    const arr = /ARRAY\[([^\]]*)\]/.exec(last!.body);
    expect(arr, `${last!.file}: office_booked_service_lines() has no ARRAY[...]`).not.toBeNull();
    const lines = [...arr![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect([...lines].sort(), last!.file).toEqual([...OFFICE_BOOKED_LINES].sort());
  });

  it("is not callable by the publishable key", () => {
    expect(code(MIGRATION)).toMatch(
      /REVOKE\s+ALL\s+ON\s+FUNCTION\s+public\.office_booked_service_lines\(\)\s+FROM\s+PUBLIC,\s*anon;/,
    );
  });
});

describe("public_services and public_quote leave an office-booked line out", () => {
  const sql = () => code(MIGRATION);

  it("splices the filter into both, beside the customer-requestable switch", () => {
    expect(sql()).toContain("pg_get_functiondef('public.public_services(text)'::regprocedure)");
    expect(sql()).toContain(
      "pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure)",
    );
    expect(sql().split(`AND ${FILTER}`).length - 1).toBe(2);
    // Each splice anchors on exactly one occurrence, and says so if it moved.
    expect(sql().match(/the splice anchor moved/g)?.length).toBe(2);
  });

  it("checks what it establishes, from any starting state", () => {
    expect(sql()).toMatch(/DO \$post\$/);
    expect(sql()).toContain(
      "IF public.office_booked_service_lines() IS DISTINCT FROM ARRAY['mobile_grooming']::text[] THEN",
    );
    expect(sql()).toContain(`p.prosrc LIKE '%${FILTER}%'`);
  });

  it("keeps the filter in any later restatement of either function", () => {
    const files = migrationFiles();
    const later = files.slice(files.indexOf(MIGRATION) + 1);
    for (const file of later) {
      for (const fn of ["public_services", "public_quote"]) {
        const body = functionBody(code(file), fn);
        if (body) expect(body, `${file} restates ${fn} without ${FILTER}`).toContain(FILTER);
      }
    }
  });
});

describe("what this change does not touch", () => {
  it("flips no switch and leaves portal_request_groom alone", () => {
    const sql = code(MIGRATION);
    expect(sql).not.toMatch(/UPDATE\s+public\.platform_service_lines/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.portal_request_groom/i);
    expect(sql).not.toMatch(/FUNCTION\s+public\.portal_request_one_off/i);
  });

  it("still lets a customer book pet waste, a walk and a sit, and not a groom", () => {
    for (const line of ["pet_waste", "dog_walking", "pet_sitting"])
      expect(customerCanBookService(line, LAUNCH_DEFAULT), line).toBe(true);
    expect(customerCanBookService("mobile_grooming", LAUNCH_DEFAULT)).toBe(false);
  });
});

describe("the booking link reads the bookable switch alone (#560)", () => {
  const sql = () => code(LATER);

  it("splices both filters out of both anon doors, and keeps the bookable one", () => {
    expect(sql()).toContain("pg_get_functiondef('public.public_services(text)'::regprocedure)");
    expect(sql()).toContain(
      "pg_get_functiondef('public.public_quote(text, text, integer, text, text, uuid)'::regprocedure)",
    );
    expect(sql().match(/the splice anchor moved/g)?.length).toBe(2);
    expect(sql()).toContain("'%customer_requestable_service_lines%'");
    expect(sql()).toContain(
      "p.prosrc LIKE '%s.service_line = ANY (public.bookable_service_lines())%'",
    );
  });

  it("changes no switch row and leaves the office-booked list and the portal doors alone", () => {
    expect(sql()).not.toMatch(/UPDATE\s+public\.platform_service_lines/i);
    expect(sql()).not.toMatch(/FUNCTION\s+public\.(portal_request_groom|portal_request_one_off)/i);
    expect(sql()).toContain(
      "IF public.office_booked_service_lines() IS DISTINCT FROM ARRAY['mobile_grooming']::text[] THEN",
    );
  });
});

describe("the proof", () => {
  it("acts it out as anon, mutates the switch, and rolls everything back", () => {
    expect(existsSync(join(ROOT, PROOF))).toBe(true);
    expect(
      existsSync(join(ROOT, "supabase/proofs/20261027200000-a-stranger-is-not-sold-a-groom.sql")),
    ).toBe(false);
    const proof = readFileSync(join(ROOT, PROOF), "utf8");
    expect(proof).toContain("SET LOCAL ROLE anon;");
    expect(proof).toContain("public.public_services('every-line-proof')");
    expect(proof).toMatch(/public\.public_quote\('every-line-proof'[^;]*k = 'groom'/);
    expect(proof).toContain("INCONCLUSIVE [mutation]");
    expect(proof.trimEnd().endsWith("ROLLBACK;")).toBe(true);
  });
});
