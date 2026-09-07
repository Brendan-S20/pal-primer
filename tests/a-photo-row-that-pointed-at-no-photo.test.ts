// The demo seeded 42 photo rows and 0 photos.
//
// `seed_demo_org` inserted a before/after pair for every fifth completed
// visit, at `demo/<kind>-<n>.jpg`. Nothing in this repository ever wrote those
// files, so all 42 rows across the three demo organizations pointed at a
// storage object that did not exist. The only visit_photos row in the database
// that resolved was the one real photo somebody uploaded through the app.
//
// The path could not have worked even with the files. Every policy on the
// visit-photos bucket reads `(storage.foldername(name))[1]` as an organization
// id, which is why a real upload lands at `<org>/<visit>/<epoch>.jpg`;
// `demo/before-1.jpg` puts the literal 'demo' where the uuid goes and the cast
// fails. What a person saw was a broken image in the office drawer and another
// in the customer portal.
//
// And the seeder's `kind` was a fourth word. It wrote 'after'; the app writes
// `z.enum(["completion","before","issue"])` and portal-ui captions exactly
// those three, giving anything else no caption at all. The column was plain
// `text` with no constraint, which is what let the fourth word exist unnoticed.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const migDir = join(root, "supabase/migrations");
const files = readdirSync(migDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const read = (f: string) => readFileSync(join(migDir, f), "utf8");

const FIX = "20260903170000_a-photo-row-that-pointed-at-no-photo.sql";
const mig = read(FIX);

describe("the seeder stops inventing photo rows", () => {
  it("removes the insert and keeps the wipe", () => {
    // The wipe is what makes the removal self-healing: with no INSERT, the
    // next reseed clears the org's dangling rows and puts nothing back. Losing
    // it would strand them and force a DELETE against a live database.
    const splice = mig.slice(mig.indexOf("DO $splice$"), mig.indexOf("$splice$;"));
    expect(splice).toMatch(/strpos\(_out, 'INSERT INTO public\.visit_photos'\) > 0/);
    expect(splice).toMatch(/strpos\(_out, 'DELETE FROM public\.visit_photos'\) = 0/);
  });

  it("is a no-op on a second run rather than a failure", () => {
    const splice = mig.slice(mig.indexOf("DO $splice$"), mig.indexOf("$splice$;"));
    const already = splice.indexOf("strpos(_def, 'INSERT INTO public.visit_photos') = 0");
    expect(already, "no already-applied branch").toBeGreaterThan(-1);
    expect(splice.slice(already, already + 200)).toMatch(/RAISE NOTICE[\s\S]*RETURN;/);
  });

  it("narrows pg_get_functiondef to one named function", () => {
    const sites = [...mig.matchAll(/pg_get_functiondef\(/g)];
    expect(sites.length).toBeGreaterThan(0);
    for (const m of sites) {
      expect(mig.slice(m.index!, m.index! + 160)).toMatch(/::regprocedure|proname\s*=\s*'/);
    }
  });
});

describe("kind is the vocabulary the app actually writes", () => {
  it("constrains the column to those three, and validates it", () => {
    expect(mig).toMatch(/CHECK \(kind IN \('completion', 'before', 'issue'\)\)/);
    expect(mig).toMatch(/VALIDATE CONSTRAINT visit_photos_kind_is_one_the_app_writes/);
  });

  it("normalizes the fourth word rather than deleting the rows", () => {
    // 'after' means 'completion' here -- the portal already prints "After" for
    // `completion`. Deleting them would throw away real rows to satisfy a
    // constraint.
    expect(mig).toMatch(
      /UPDATE public\.visit_photos SET kind = 'completion' WHERE kind = 'after';/,
    );
    // At statement position only: the phrase also appears inside the splice's
    // own guard (`strpos(_out, 'DELETE FROM public.visit_photos') = 0`), which
    // is there to keep the seeder's wipe, not to delete anything here.
    const statements = mig.split("\n").filter((l) => /^\s*DELETE\s+FROM/i.test(l));
    expect(statements, `this migration deletes rows: ${statements}`).toEqual([]);
  });

  it("matches the enum the app validates uploads against", () => {
    // If my-day's zod enum gains a kind, this constraint has to gain it too,
    // or the upload starts failing at the database instead of the form.
    const src = readFileSync(join(root, "src/lib/my-day.functions.ts"), "utf8");
    const m = src.match(/kind:\s*z\.enum\(\[([^\]]+)\]\)/);
    expect(m, "the upload enum moved").not.toBeNull();
    const appKinds = [...m![1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]).sort();
    const check = mig.match(/CHECK \(kind IN \(([^)]+)\)\)/);
    const dbKinds = [...check![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(dbKinds).toEqual(appKinds);
  });

  it("still captions every one of them in the portal", () => {
    // An unknown kind renders with no caption, deliberately. That is the right
    // fallback and also why a fourth word was invisible for two months.
    const ui = readFileSync(join(root, "src/lib/portal-ui.tsx"), "utf8");
    for (const k of ["before", "completion", "issue"]) {
      expect(ui, `portal-ui does not caption ${k}`).toMatch(new RegExp(`kind === "${k}"`));
    }
  });
});

describe("the migration reports rather than asserts what it did not create", () => {
  it("warns on dangling rows instead of failing a replay", () => {
    const from = mig.indexOf("INTO _rows, _dangling");
    expect(from).toBeGreaterThan(-1);
    const measured = mig.slice(from);
    expect(measured).toMatch(/RAISE WARNING/);
    expect(measured).not.toMatch(/RAISE EXCEPTION/);
  });

  it("asserts only the objects it establishes", () => {
    const verify = mig.slice(mig.indexOf("DO $verify$"), mig.indexOf("$verify$;"));
    const exceptions = verify.split("RAISE EXCEPTION").slice(1);
    expect(exceptions.length).toBeGreaterThan(0);
    // Every exception is about the constraint or the function this file just
    // changed -- none of them counts rows.
    for (const e of exceptions) {
      expect(e.slice(0, 160)).toMatch(/constraint|seed_demo_org/);
    }
  });
});

describe("nothing later puts the insert back", () => {
  it("has no later migration recreating seed_demo_org with photo seeding", () => {
    const after = files.filter((f) => f > FIX);
    const reverts = after.filter((f) => {
      const b = read(f);
      return (
        b.includes("CREATE OR REPLACE FUNCTION public.seed_demo_org") &&
        b.includes("INSERT INTO public.visit_photos")
      );
    });
    expect(reverts, `these re-add photo seeding: ${reverts}`).toEqual([]);
  });
});
