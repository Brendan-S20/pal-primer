import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasPermission } from "@/lib/permissions";
import { runsTrainingOffice } from "@/lib/training-packages";

// #555: a dispatcher could see a client's training package and its lessons,
// and had no Book, Extend or Cancel on it, while an owner on the same unpaid
// package did. Three layers said manage_pricing (the card, bookTrainingSessions
// and the subscriptions write policy) where everything else in the path said
// can_write_org. Booking now goes through one narrow function; the policy on
// subscriptions does not move.

const root = join(import.meta.dirname, "..");
const MIGRATIONS = join(root, "supabase", "migrations");
const FILE = "20261027130000_a-dispatcher-books-a-sold-package.sql";
const sql = readFileSync(join(MIGRATIONS, FILE), "utf8");
const code = sql
  .split("\n")
  .filter((l) => !/^\s*--/.test(l))
  .join("\n");
const fn = code.slice(code.indexOf("CREATE OR REPLACE FUNCTION public.book_training_package_plan"));
const body = fn.slice(0, fn.indexOf("$function$;"));

describe("who runs a sold package", () => {
  it("is the roles can_write_org admits, dispatcher included, and never a tech", () => {
    expect(runsTrainingOffice("owner")).toBe(true);
    expect(runsTrainingOffice("office_manager")).toBe(true);
    expect(runsTrainingOffice("dispatcher")).toBe(true);
    expect(runsTrainingOffice("tech")).toBe(false);
    expect(runsTrainingOffice(null)).toBe(false);
  });
  it("still does not make a dispatcher a pricer or a biller", () => {
    expect(hasPermission("dispatcher", "manage_pricing")).toBe(false);
    expect(hasPermission("dispatcher", "manage_client_billing")).toBe(false);
  });
});

describe("book_training_package_plan", () => {
  it("is the only migration that defines it, and the latest to touch it", () => {
    const definers = readdirSync(MIGRATIONS)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) =>
        /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.book_training_package_plan\b/i.test(
          readFileSync(join(MIGRATIONS, f), "utf8"),
        ),
      );
    expect(definers).toEqual([FILE]);
  });
  it("checks can_write_org on the package's own business before anything else", () => {
    const gate = body.indexOf("public.can_write_org((select auth.uid()), _p.organization_id)");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(body.indexOf("FROM public.properties"));
    expect(gate).toBeLessThan(body.indexOf("INSERT INTO public.subscriptions"));
    expect(body).toContain("SECURITY DEFINER");
    expect(body).toContain("SET search_path TO 'public', 'pg_temp'");
  });
  it("takes no price, cadence, service or client from the caller", () => {
    const params = fn.slice(fn.indexOf("("), fn.indexOf("RETURNS"));
    expect(params).not.toMatch(/price|cadence|_service|_client_id|_org/i);
    expect(body).toContain("_p.organization_id, _p.client_id, _property_id, _p.service_id, _p.id");
    expect(body).toContain("0, 'postpaid'");
  });
  it("only books an address of the package's own client in its own business", () => {
    expect(body).toContain("AND pr.client_id = _p.client_id");
    expect(body).toContain("AND pr.organization_id = _p.organization_id");
  });
  it("keeps the account shape the office path wrote: dogs on a home, one unit on a business", () => {
    expect(body).toContain(
      "CASE WHEN _account = 'commercial' THEN NULL ELSE GREATEST(1, _dogs) END",
    );
    expect(body).toContain("CASE WHEN _account = 'commercial' THEN 1 ELSE NULL END");
    expect(body).toContain("WHEN _weekday IS NULL THEN 'one_time' ELSE 'weekly'");
  });
  it("is not reachable by anon, and says so after it runs", () => {
    expect(code).toContain(
      "REVOKE ALL ON FUNCTION public.book_training_package_plan(uuid, uuid, date, date, smallint, time, time) FROM PUBLIC, anon;",
    );
    expect(code).toMatch(
      /IF has_function_privilege\('anon', _fn, 'EXECUTE'\) THEN\s+RAISE EXCEPTION/,
    );
  });
  it("leaves the subscriptions write policy alone", () => {
    expect(code).not.toMatch(/POLICY[^;]*ON\s+public\.subscriptions/i);
  });
});

describe("the app asks the same question the database does", () => {
  const server = readFileSync(join(root, "src/lib/training-packages.server.ts"), "utf8");
  const booking = server.slice(server.indexOf("export async function bookTrainingSessions"));
  const card = readFileSync(
    join(root, "src/components/clients/TrainingPackagesSection.tsx"),
    "utf8",
  );
  it("books through the function, gated on the training office rather than manage_pricing", () => {
    expect(booking).toContain("await requireTrainingOffice(db, userId)");
    expect(booking).not.toContain('"manage_pricing"');
    expect(booking).toContain('db.rpc("book_training_package_plan"');
    expect(booking).not.toMatch(/from\("subscriptions"\)\s*\.insert/);
  });
  it("shows Book, Extend and Cancel to the training office and keeps Sell for billing", () => {
    expect(card).toContain("const canBook = runsTrainingOffice(role);");
    expect(card).toContain('const canBill = can("manage_client_billing");');
    expect(card).toMatch(/\{canBook && p\.state !== "canceled" && \(/);
    expect(card).not.toContain('can("manage_pricing")');
  });
});
