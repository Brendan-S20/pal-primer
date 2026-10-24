// The database's list of bookable service lines is the app's list.
//
// setServiceLines refuses adding a line outside BOOKABLE_SERVICE_LINES, and
// 20261017004000 refuses the same thing for a REST write, reading
// public.bookable_service_lines(). Two copies of one list: when a line is
// approved to go live, both change in the same PR, or this fails.
//
// The SQL copy is read from the LAST migration that defines the function, so
// a later migration that re-creates it is the one compared.

import { describe, expect, it } from "vitest";
import { BOOKABLE_SERVICE_LINES, SERVICE_LINES } from "@/lib/service-lines";
import { migrationFiles, readMigration, stripLineComments } from "./support/sql-migrations";

const GUARD = "20261017004000_a-service-line-is-turned-on-only-when-bookable.sql";

function sqlBookable(): { file: string; lines: string[] } | null {
  let found: { file: string; lines: string[] } | null = null;
  for (const file of migrationFiles()) {
    const sql = stripLineComments(readMigration(file));
    const m =
      /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.bookable_service_lines\s*\(\s*\)[\s\S]*?SELECT\s+ARRAY\[([^\]]*)\]::text\[\]/i.exec(
        sql,
      );
    if (m) {
      const lines = [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
      found = { file, lines };
    }
  }
  return found;
}

describe("a service line is turned on only when bookable", () => {
  it("finds public.bookable_service_lines() rather than passing on nothing", () => {
    const found = sqlBookable();
    expect(found).not.toBeNull();
    expect(found!.lines.length).toBeGreaterThan(0);
  });

  it("holds the same lines as BOOKABLE_SERVICE_LINES", () => {
    expect([...sqlBookable()!.lines].sort()).toEqual([...BOOKABLE_SERVICE_LINES].sort());
  });

  it("is pinned to exactly pet waste and dog walking, by the #530 flip", () => {
    const found = sqlBookable()!;
    expect(found.file).toBe("20261024230000_dog-walking-is-bookable.sql");
    expect(found.lines).toEqual(["pet_waste", "dog_walking"]);
  });

  it("the flip asserts the exact list on replay, not a superset", () => {
    const sql = stripLineComments(readMigration("20261024230000_dog-walking-is-bookable.sql"));
    expect(sql).toMatch(
      /IF public\.bookable_service_lines\(\) IS DISTINCT FROM ARRAY\['pet_waste', 'dog_walking'\]::text\[\] THEN\s+RAISE EXCEPTION/,
    );
  });

  it("holds only lines the database accepts", () => {
    for (const line of sqlBookable()!.lines) {
      expect(SERVICE_LINES as readonly string[]).toContain(line);
    }
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
});
