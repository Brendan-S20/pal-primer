/** My Day, visit detail and the client properties tab load under the grants
 *  the migrations leave behind (#492).
 *
 *  On 2026-10-17 a migration narrowed SELECT on properties to every column
 *  but the access codes, and production still sent selects that named them.
 *  PostgREST refused each request whole with 42501, "permission denied for
 *  table properties". walk-access.db.test.ts already proves the codes are
 *  refused; nothing proved the queries the app sends are NOT refused.
 *
 *  So this does not copy the column lists. It reads every select on visits
 *  or properties out of the three files those screens use, as they are on
 *  this commit, and runs each one as the owner and as today's walker against
 *  a database built from the migrations. A query that names a withheld column,
 *  or a migration that withholds a column a query names, fails here with the
 *  file and line.
 *
 *  The first case runs the select production sent before 8a344a86 and asserts
 *  it is refused with 42501, so a green run means the grants are narrowed and
 *  the app's queries still fit them, not that nothing was narrowed.
 *
 *  Local stack only; skipped without TEST_SUPABASE_* env, as the rest of
 *  tests/integration is. The sandboxes database job sets them. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dbEnabled, makeWalkOrg, makeWalkVisit, type WalkOrg } from "../support/walk-db";
import { selectCalls } from "../support/withheld-columns";

const root = join(import.meta.dirname, "..", "..");

/** My Day, visit detail, and the client page's properties tab. */
const SCREENS = [
  "src/lib/my-day.functions.ts",
  "src/lib/visits.functions.ts",
  "src/lib/properties.functions.ts",
] as const;

type Query = { where: string; table: "visits" | "properties"; columns: string };

/** Every select on properties, and every select on visits that embeds it. */
function appQueries(): Query[] {
  return SCREENS.flatMap((file) =>
    selectCalls(file, readFileSync(join(root, file), "utf8")).flatMap((call) => {
      if (call.columns == null) return [];
      if (call.table === "properties")
        return [
          { where: `${file}:${call.line}`, table: "properties" as const, columns: call.columns },
        ];
      if (call.table === "visits" && /\bproperties\s*[(!]/.test(call.columns))
        return [{ where: `${file}:${call.line}`, table: "visits" as const, columns: call.columns }];
      return [];
    }),
  );
}

/** The My Day embed production sent on 2026-10-17, from the edge logs in #492. */
const BEFORE_THE_FIX =
  "id, scheduled_on, status, properties(label, street, city, postal_code, has_units, gate_code, lock_box_code, key_location, parking_notes)";

let org: WalkOrg;
let propertyId: string;

describe.skipIf(!dbEnabled)("the screens #492 took down, under the narrowed grants", () => {
  const queries = appQueries();

  beforeAll(async () => {
    org = await makeWalkOrg("Grant drift");
    ({ propertyId } = await makeWalkVisit(org, {
      assignedStaffId: org.walker.staffId,
      lockBoxCode: "4471",
      gateCode: "*8080#",
    }));
  });

  afterAll(async () => {
    if (org) await org.cleanup();
  });

  const people = () =>
    [
      ["the owner", org.owner],
      ["today's walker", org.walker],
    ] as const;

  it("reads the queries out of the app", () => {
    // My Day's visits list, visit detail, and the client page's properties list.
    const where = queries.map((q) => q.where.split(":")[0]);
    for (const file of SCREENS) expect(where, `no select read from ${file}`).toContain(file);
    expect(queries.some((q) => q.table === "visits" && q.where.startsWith("src/lib/my-day"))).toBe(
      true,
    );
    expect(queries.some((q) => q.table === "properties")).toBe(true);
  });

  it("refuses the select production sent before the fix, so this can fail", async () => {
    for (const [, who] of people()) {
      const { data, error } = await who.client
        .from("visits")
        .select(BEFORE_THE_FIX)
        .eq("organization_id", org.orgId);
      expect(error?.code).toBe("42501");
      expect(data ?? []).toEqual([]);
    }
  });

  it("runs every app query as the owner and as today's walker without a permission error", async () => {
    const refused: string[] = [];
    for (const [name, who] of people()) {
      for (const q of queries) {
        const { error } = await who.client
          .from(q.table)
          .select(q.columns)
          .eq("organization_id", org.orgId)
          .limit(5);
        if (error) refused.push(`${q.where} as ${name}: ${error.code} ${error.message}`);
      }
    }
    expect(refused).toEqual([]);
  });

  it("gives My Day today's stop with its property, for the owner and the walker", async () => {
    const myDay = queries.filter(
      (q) => q.table === "visits" && q.where.startsWith("src/lib/my-day"),
    );
    for (const [name, who] of people()) {
      for (const q of myDay) {
        const { data, error } = await who.client
          .from("visits")
          .select(q.columns)
          .eq("organization_id", org.orgId)
          .eq("property_id", propertyId);
        expect(error, `${q.where} as ${name}`).toBeNull();
        const rows = (data ?? []) as unknown as { properties: unknown }[];
        expect(rows.length, `${q.where} as ${name} returned no visit`).toBeGreaterThan(0);
        expect(rows[0].properties, `${q.where} as ${name} returned no property`).not.toBeNull();
      }
    }
  });

  it("gives the client page its property, for the owner and the walker", async () => {
    const list = queries.filter((q) => q.table === "properties");
    for (const [name, who] of people()) {
      const counted = await Promise.all(
        list.map(async (q) => {
          const { data, error } = await who.client
            .from("properties")
            .select(q.columns)
            .eq("id", propertyId);
          expect(error, `${q.where} as ${name}`).toBeNull();
          return (data ?? []).length;
        }),
      );
      // "Properties 0" was the symptom: every list query must see the row.
      expect(
        counted.every((n) => n === 1),
        `as ${name}: ${counted.join(", ")}`,
      ).toBe(true);
    }
  });

  it("still serves the codes through property_access_codes", async () => {
    for (const [, who] of people()) {
      const { data, error } = await who.client.rpc("property_access_codes", {
        _property_ids: [propertyId],
      });
      expect(error).toBeNull();
      expect(data).toEqual([
        expect.objectContaining({
          property_id: propertyId,
          gate_code: "*8080#",
          lock_box_code: "4471",
        }),
      ]);
    }
  });
});
