// An embed names its foreign key when there is more than one (#603).
//
// ── THE BUG ───────────────────────────────────────────────────────────────
//
// 20261029150000 (#574, shipped in #584) added services.public_package_id,
// a foreign key to service_packages. service_packages.service_id already
// pointed the other way. With two keys between the same two tables,
//
//     .from("service_packages").select("*, services(name)")
//
// no longer says which one to join on, and PostgREST answers PGRST201
// instead of rows. Three selects did that: the office's package sale, its
// booking options, and the portal's Training page. Nothing in the migration
// touched those files, so nothing that reviewed the migration looked at them.
//
// ── WHAT THIS CHECKS ──────────────────────────────────────────────────────
//
// Every `.from("t").select("...")` in src/ whose string can be read off the
// source, and every embed in it, nested ones included. The foreign keys come
// from src/integrations/supabase/types.ts, so this runs anywhere with no
// database. An embed with two or more keys between its tables and no `!hint`
// fails, and so does a hint that names no key or column between them.
//
// An embed whose name is neither a table nor a foreign key column of its
// parent also fails: PostgREST answers that with PGRST200 (#683).
//
// A select passed through a helper, `scoped(select)`, is read at each call
// of the helper. The name `select` is looked up where it is used, as the
// language does: until #683 it was looked up file-wide, so a parameter
// picked up an unrelated `const select` elsewhere in the file and the
// database half failed on a query production never sends.
//
// types.ts is generated, and can lag a migration. The database half,
// tests/integration/every-select-embed-resolves.db.test.ts, asks a real
// PostgREST built from the migrations the same question, so a key types.ts
// has not caught up with is caught there.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidates,
  collectSelects,
  embedsOf,
  foreignKeysFromTypes,
  relationsFromTypes,
  type Fk,
} from "./support/select-embeds";

const root = join(import.meta.dirname, "..");
const typesTs = () => readFileSync(join(root, "src/integrations/supabase/types.ts"), "utf8");
const fks = () => foreignKeysFromTypes(typesTs());

/** Embeds that join a name that is neither a table nor, on the parent, a
 *  single-column foreign key: PostgREST's PGRST200, "Could not find a
 *  relationship between 'clients' and 'assigned_staff_id'". */
function unknownTargets(
  sites: { file: string; line: number; table: string; select: string }[],
  all: Fk[],
  relations: Set<string>,
): string[] {
  const bad: string[] = [];
  for (const s of sites) {
    for (const e of embedsOf(s.table, s.select, all)) {
      if (relations.has(e.target)) continue;
      bad.push(
        `${s.file}:${s.line}  ${e.parent} -> ${e.text}: "${e.target}" is not a table, and not a foreign key column of ${e.parent} (PGRST200)`,
      );
    }
  }
  return bad;
}

/** A throwaway repo root holding one src/ file, for the collector. */
function withSource<T>(source: string, run: (root: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "select-embeds-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "x.ts"), source);
    return run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("an embed names its foreign key when there is more than one", () => {
  it("reads the foreign keys out of types.ts", () => {
    const all = fks();
    expect(all.length).toBeGreaterThan(100);
    // The two keys #603 is about, so a types.ts that drops either is noticed.
    const names = all.map((f) => f.name);
    expect(names).toContain("service_packages_service_id_fkey");
    expect(names).toContain("services_public_package_id_fkey");
  });

  it("finds the selects, and nearly all of them", () => {
    const { sites, skipped } = collectSelects(root);
    expect(sites.length).toBeGreaterThan(1000);
    // Built at runtime and so unreadable here. A rise means a new select this
    // check cannot see; read it, and if it embeds, make it readable.
    expect(
      skipped.length,
      skipped.map((s) => `${s.file}:${s.line}`).join("\n"),
    ).toBeLessThanOrEqual(3);
  });

  it("every embed with two candidate keys says which one", () => {
    const all = fks();
    const bad: string[] = [];
    for (const s of collectSelects(root).sites) {
      for (const e of embedsOf(s.table, s.select, all)) {
        const keys = candidates(all, e.parent, e.target);
        if (e.hint) {
          if (!keys.some((k) => k.name === e.hint || k.columns.includes(e.hint!)))
            bad.push(
              `${s.file}:${s.line}  ${e.parent} -> ${e.text}: "${e.hint}" is not a key or column between them (PGRST200)`,
            );
        } else if (keys.length > 1) {
          bad.push(
            `${s.file}:${s.line}  ${e.parent} -> ${e.text}: ${keys.length} keys (${keys
              .map((k) => k.name)
              .join(", ")}), no hint (PGRST201). Write ${e.target}!<key>(...)`,
          );
        }
      }
    }
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("every embed joins a table, or a foreign key column of its parent", () => {
    const relations = relationsFromTypes(typesTs());
    expect(relations.size).toBeGreaterThan(100);
    expect(relations.has("clients")).toBe(true);
    const bad = unknownTargets(collectSelects(root).sites, fks(), relations);
    expect(bad, bad.join("\n")).toEqual([]);
  });

  it("would have caught clients -> staff:assigned_staff_id (#683)", () => {
    // What the database half was sent for clients.functions.ts:637: the
    // visits select, embedding the visit's tech by its column, against
    // clients, which has no such column.
    const all = fks();
    const relations = relationsFromTypes(typesTs());
    const site = {
      file: "src/lib/clients.functions.ts",
      line: 637,
      table: "clients",
      select: "id, assigned_staff_id, staff:assigned_staff_id(display_name)",
    };
    expect(unknownTargets([site], all, relations)).toHaveLength(1);
    // The same embed hangs off visits, where the column is a foreign key.
    expect(unknownTargets([{ ...site, table: "visits" }], all, relations)).toEqual([]);
  });

  it("looks a select's name up in its own scope, not anywhere in the file", () => {
    const source = `
      const db: any = null;
      export function search() {
        const cols = "id, display_name";
        const scoped = (select: string) => db.from("clients").select(select);
        scoped(\`\${cols}, properties(street)\`);
        scoped(cols);
      }
      export function visits() {
        const select = "id, staff:assigned_staff_id(display_name)";
        return db.from("visits").select(select);
      }
      export function shadowed(select: string) {
        return db.from("clients").select(select);
      }
    `;
    const { sites, skipped } = withSource(source, (dir) => collectSelects(dir));
    const at = (table: string) =>
      sites
        .filter((s) => s.table === table)
        .map((s) => s.select)
        .sort();
    // The helper's parameter is read at each call of the helper.
    expect(at("clients")).toEqual(["id, display_name", "id, display_name, properties(street)"]);
    // The visits const stays with visits.
    expect(at("visits")).toEqual(["id, staff:assigned_staff_id(display_name)"]);
    // An exported function's parameter is not readable, and is not
    // mistaken for the const of the same name above it.
    expect(skipped.map((s) => [s.table, s.select])).toEqual([["clients", "select"]]);
    expect(unknownTargets(sites, fks(), relationsFromTypes(typesTs()))).toEqual([]);
  });

  it("would have caught the select #603 shipped", () => {
    const all = fks();
    const shipped = embedsOf("service_packages", "*, services(name)", all);
    expect(candidates(all, shipped[0].parent, shipped[0].target)).toHaveLength(2);
    expect(shipped[0].hint).toBeNull();
    const fixed = embedsOf(
      "service_packages",
      "*, services!service_packages_service_id_fkey(name)",
      all,
    );
    expect(fixed[0].hint).toBe("service_packages_service_id_fkey");
  });

  it("reads aliases, nesting, !inner and a column used as the key", () => {
    const all = fks();
    const e = embedsOf(
      "qc_tickets",
      "id, visit:visits!qc_tickets_visit_id_fkey(scheduled_on, properties(street)), services!inner(name), count()",
      all,
    );
    expect(e.map((x) => [x.parent, x.target, x.hint])).toEqual([
      ["qc_tickets", "visits", "qc_tickets_visit_id_fkey"],
      ["visits", "properties", null],
      ["qc_tickets", "services", null],
    ]);
    const viaColumn = embedsOf("visits", "staff:assigned_staff_id(display_name)", all);
    expect(viaColumn[0].target).toBe("staff");
    expect(viaColumn[0].hint).not.toBeNull();
  });
});
