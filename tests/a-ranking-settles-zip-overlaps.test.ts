// A ranking settles a ZIP two service areas list (#858, parts 2 and 3).
//
// Brendan, 2026-11-10: "there should be a ranking system for priority;
// sometimes the zip codes are going to automatically overlap and there's too
// much steps to walkthrough and manually fix that." And the two decisions
// from 2:01 PM: "Rank existing areas newest first", and "Yes, warn the owner"
// when an area loses every one of its ZIPs to areas ranked above it.
//
// What is pinned here:
//   * the rank is zones.priority: the top of the list has the highest number,
//     so the matcher and public_quote settle an overlap with no change;
//   * with three overlapping areas and a ZIP all three list, the top one gets
//     it; swapping two ranks flips it; the answer is stable;
//   * reorderZones writes the business densely, N down to 1, and re-detects;
//   * the warning names the area and the areas that took its ZIPs, clears
//     when the area is moved above them, and a partial overlap is not warned;
//   * the migration ranks each business's existing areas newest first, is
//     scoped per business, and changes nothing when run twice -- read from the
//     file here, and proved against a real Postgres below when one answers.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  areasWithNoZipLeft,
  fullOrder,
  MIN_PRIORITY,
  moveInRanking,
  noZipLeftSentence,
  outcomeSummary,
  placeAtBottom,
  prioritiesForOrder,
  rankedZones,
  rankOf,
  zipOutcomes,
  zipWinners,
  type RankedZone,
} from "@/lib/zone-ranking";
import { matchZone } from "@/lib/zone-match";

// A proof waits its turn for the shared lock (tests/the-proofs-take-turns.test.ts).
vi.setConfig({ testTimeout: 300_000 });

vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate: (data: unknown) => unknown = (data) => data;
    const builder = {
      middleware: () => builder,
      inputValidator: (fn: typeof validate) => {
        validate = fn;
        return builder;
      },
      handler:
        (fn: (args: { data: unknown; context: unknown }) => unknown) =>
        async (args?: { data: unknown }) =>
          fn({ data: validate(args?.data), context: { supabase: state.db, userId: "user-1" } }),
    };
    return builder;
  },
}));
vi.mock("@/integrations/supabase/auth-middleware", () => ({ requireSupabaseAuth: {} }));
vi.mock("@/lib/authz.server", () => ({
  resolveCaller: async () => ({ orgId: "org-1", role: "owner" }),
  requirePermission: async (_db: unknown, _u: unknown, perm: string) => {
    state.permissionsAsked.push(perm);
    return { orgId: "org-1", role: "owner" };
  },
}));
vi.mock("@/lib/zones-redetect.server", () => ({
  redetectZonesForOrg: async () => {
    state.redetects++;
    return 2;
  },
}));

const ROOT = join(import.meta.dirname, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const MIGRATION =
  "supabase/migrations/20261112030000_a-service-area-fills-its-zips-and-a-ranking-settles-overlaps.sql";

const state = vi.hoisted(() => ({
  db: null as any,
  redetects: 0,
  permissionsAsked: [] as string[],
}));

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";

const zone = (id: string, name: string, priority: number, zip_codes: string[], over = {}) =>
  ({ id, name, priority, zip_codes, enabled: true, ...over }) as RankedZone & {
    enabled: boolean;
  };

/** Three overlapping areas: 48226 is in all three, 48201 in A and B, 48202
 *  only in C. */
const THREE = [
  zone(A, "Downtown", 3, ["48226", "48201"]),
  zone(B, "Midtown", 2, ["48226", "48201", "48202x".slice(0, 5)]),
  zone(C, "Riverfront", 1, ["48226", "48202"]),
];

describe("the rank is the priority", () => {
  it("lists the highest priority first, and ties by id as the matcher does", () => {
    expect(rankedZones(THREE).map((z) => z.name)).toEqual(["Downtown", "Midtown", "Riverfront"]);
    expect([...rankOf(THREE).entries()]).toEqual([
      [A, 1],
      [B, 2],
      [C, 3],
    ]);
    const tied = [zone(C, "c", 0, []), zone(A, "a", 0, []), zone(B, "b", 0, [])];
    expect(rankedZones(tied).map((z) => z.id)).toEqual([A, B, C]);
    expect(matchZone(tied.map((z) => ({ ...z, zip_codes: ["48226"] })), { postalCode: "48226" })?.id).toBe(A);
  });

  it("an order writes N down to 1", () => {
    expect([...prioritiesForOrder([C, A, B]).entries()]).toEqual([
      [C, 3],
      [A, 2],
      [B, 1],
    ]);
  });

  it("a partial order keeps the rest in their current order, and drops a stranger", () => {
    expect(fullOrder([C], THREE)).toEqual([C, A, B]);
    expect(fullOrder(["not-ours", B, B], THREE)).toEqual([B, A, C]);
  });

  it("a new area goes under the lowest; at the floor the list is renumbered first", () => {
    expect(placeAtBottom([])).toEqual({ priority: 0, renumber: null });
    expect(placeAtBottom(THREE)).toEqual({ priority: 0, renumber: null });
    expect(placeAtBottom([zone(A, "a", 0, [])])).toEqual({ priority: -1, renumber: null });
    const floor = placeAtBottom([zone(A, "a", MIN_PRIORITY, []), zone(B, "b", -5, [])]);
    expect(floor.priority).toBe(0);
    expect([...floor.renumber!.entries()]).toEqual([
      [B, 2],
      [A, 1],
    ]);
  });

  it("moving one step swaps two neighbours and nothing past the ends", () => {
    expect(moveInRanking(THREE, C, "up")).toEqual([A, C, B]);
    expect(moveInRanking(THREE, A, "down")).toEqual([B, A, C]);
    expect(moveInRanking(THREE, A, "up")).toEqual([A, B, C]);
    expect(moveInRanking(THREE, C, "down")).toEqual([A, B, C]);
  });
});

describe("a ZIP in several areas goes to the highest-ranked one", () => {
  it("with three overlapping areas, the top one gets the ZIP all three list", () => {
    const winners = zipWinners(THREE);
    expect(winners.get("48226")?.name).toBe("Downtown");
    expect(winners.get("48201")?.name).toBe("Downtown");
    expect(winners.get("48202")?.name).toBe("Midtown");
  });

  it("swapping two ranks flips the ZIP, and asking twice gives the same answer", () => {
    const swapped = THREE.map((z) =>
      z.id === A ? { ...z, priority: 1 } : z.id === C ? { ...z, priority: 3 } : z,
    );
    expect(zipWinners(swapped).get("48226")?.name).toBe("Riverfront");
    expect(zipWinners(swapped).get("48201")?.name).toBe("Midtown");
    expect(zipWinners(swapped).get("48226")?.name).toBe("Riverfront");
    expect(zipWinners(THREE).get("48226")?.name).toBe("Downtown");
  });

  it("is the matcher's own answer, so the signup quote and the screen agree", () => {
    for (const zip of ["48226", "48201", "48202"]) {
      expect(zipWinners(THREE).get(zip)?.id).toBe(matchZone(THREE, { postalCode: zip })?.id);
    }
  });

  it("an area that is off is out of the running and keeps its list for later", () => {
    const off = THREE.map((z) => (z.id === A ? { ...z, enabled: false } : z));
    expect(zipWinners(off).get("48226")?.name).toBe("Midtown");
    expect(zipOutcomes(off).map((o) => o.name)).toEqual(["Midtown", "Riverfront"]);
  });

  it("says per area what it keeps and what it lost to whom", () => {
    const by = new Map(zipOutcomes(THREE).map((o) => [o.name, o]));
    expect(by.get("Downtown")).toMatchObject({ won: ["48226", "48201"], lostTo: [] });
    expect(by.get("Midtown")).toMatchObject({
      won: ["48202"],
      lostTo: [{ name: "Downtown", zips: ["48226", "48201"] }],
    });
    expect(by.get("Riverfront")).toMatchObject({
      won: [],
      lostTo: [
        { name: "Downtown", zips: ["48226"] },
        { name: "Midtown", zips: ["48202"] },
      ],
    });
    expect(outcomeSummary(by.get("Downtown"), 2)).toBe("2 of 2 ZIPs");
    expect(outcomeSummary(by.get("Midtown"), 3)).toBe("1 of 3 ZIPs, 2 to “Downtown”");
    expect(outcomeSummary(by.get("Riverfront"), 2)).toBe(
      "0 of 2 ZIPs, 2 to “Downtown” and “Midtown”",
    );
    expect(outcomeSummary(undefined, 0)).toBe("No ZIPs listed");
    expect(outcomeSummary(undefined, 4)).toBe("4 ZIPs listed, off");
  });
});

describe("the warning: an area that keeps none of its ZIPs", () => {
  it("names the area and the area that took its ZIPs", () => {
    const a = zone(A, "Eastside", 1, ["48213", "48214"]);
    const b = zone(B, "Whole city", 2, ["48213", "48214", "48215"]);
    const w = areasWithNoZipLeft([a, b]);
    expect(w).toHaveLength(1);
    expect(w[0].name).toBe("Eastside");
    expect(noZipLeftSentence(w[0])).toBe(
      "“Eastside” keeps none of its ZIPs: “Whole city” ranks higher and takes all 2 of its ZIPs. Move “Eastside” up to give it ZIPs back, or change its area.",
    );
  });

  it("clears once the area is moved above the one that took them", () => {
    const a = zone(A, "Eastside", 1, ["48213", "48214"]);
    const b = zone(B, "Whole city", 2, ["48213", "48214", "48215"]);
    const order = moveInRanking([a, b], A, "up");
    const p = prioritiesForOrder(order);
    const after = [a, b].map((z) => ({ ...z, priority: p.get(z.id)! }));
    expect(areasWithNoZipLeft(after)).toEqual([]);
    // And now the other one still keeps something, so no warning moves over.
    expect(zipOutcomes(after).find((o) => o.name === "Whole city")?.won).toEqual(["48215"]);
  });

  it("a partial overlap, where the area keeps at least one ZIP, is not warned", () => {
    const a = zone(A, "Eastside", 1, ["48213", "48214"]);
    const b = zone(B, "Whole city", 2, ["48213"]);
    expect(areasWithNoZipLeft([a, b])).toEqual([]);
  });

  it("names every area that took a ZIP, and a single ZIP in the singular", () => {
    const a = zone(A, "Eastside", 1, ["48213", "48214"]);
    const b = zone(B, "North", 3, ["48213"]);
    const c = zone(C, "South", 2, ["48214"]);
    const w = areasWithNoZipLeft([a, b, c]);
    expect(noZipLeftSentence(w[0])).toBe(
      "“Eastside” keeps none of its ZIPs: “North” and “South” rank higher and take all 2 of its ZIPs. Move “Eastside” up to give it ZIPs back, or change its area.",
    );
    const one = areasWithNoZipLeft([zone(A, "Eastside", 1, ["48213"]), b]);
    expect(noZipLeftSentence(one[0])).toMatch(/takes its only ZIP\./);
  });

  it("an area listing no ZIPs, or one that is off, is a different story and not warned here", () => {
    const empty = zone(A, "Empty", 1, []);
    const off = zone(B, "Off", 1, ["48213"], { enabled: false });
    const big = zone(C, "Big", 2, ["48213"]);
    expect(areasWithNoZipLeft([empty, off, big])).toEqual([]);
  });
});

// ── reorderZones, the server half ──────────────────────────────────────────

function fakeDb(zones: Array<Record<string, any>>) {
  const rows = zones.map((z) => ({ ...z }));
  const updates: Array<{ id: string; org: string; patch: Record<string, any> }> = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const db = {
    rows,
    updates,
    rpcCalls,
    // reorder_zones as the migration defines it: one statement over the
    // business's whole list, top to bottom.
    rpc: async (name: string, args: any) => {
      rpcCalls.push({ name, args });
      if (name !== "reorder_zones") throw new Error(`unexpected rpc ${name}`);
      const ids: string[] = args._ids;
      const mine = rows.filter((r) => r.organization_id === args._org_id);
      if (ids.length !== mine.length || ids.some((id) => !mine.some((r) => r.id === id))) {
        return { data: null, error: { message: "reorder_zones: the list is not this business's areas" } };
      }
      ids.forEach((id, i) => {
        rows.find((r) => r.id === id)!.priority = ids.length - i;
      });
      return { data: ids.length, error: null };
    },
    from: (table: string) => {
      if (table !== "zones") throw new Error(`unexpected table ${table}`);
      const filters: Array<[string, unknown]> = [];
      let patch: Record<string, any> | null = null;
      const chain: any = {
        select: () => chain,
        eq: (k: string, v: unknown) => {
          filters.push([k, v]);
          return chain;
        },
        update: (p: Record<string, any>) => {
          patch = p;
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) => {
          const matching = rows.filter((r) => filters.every(([k, v]) => r[k] === v));
          if (patch) {
            updates.push({
              id: filters.find(([k]) => k === "id")?.[1] as string,
              org: filters.find(([k]) => k === "organization_id")?.[1] as string,
              patch,
            });
            for (const r of matching) Object.assign(r, patch);
            return resolve({ data: null, error: null });
          }
          return resolve({ data: matching, error: null });
        },
      };
      return chain;
    },
  };
  return db;
}

const dbZone = (id: string, name: string, priority: number) => ({
  id,
  name,
  priority,
  organization_id: "org-1",
});

beforeEach(() => {
  state.redetects = 0;
  state.permissionsAsked = [];
});

describe("reorderZones", () => {
  it("writes the business's areas N down to 1 in the order sent, in one statement, and re-detects", async () => {
    state.db = fakeDb([dbZone(A, "Downtown", 3), dbZone(B, "Midtown", 2), dbZone(C, "Riverfront", 1)]);
    const { reorderZones } = await import("@/lib/zones.functions");
    const out = await reorderZones({ data: { ids: [C, A, B] } } as any);
    expect(state.permissionsAsked).toContain("manage_pricing");
    expect(out.order).toEqual([C, A, B]);
    // One call to the migration's reorder_zones, scoped to the business, and
    // not a row-by-row loop that a failure could leave half done.
    expect(state.db.rpcCalls).toEqual([
      { name: "reorder_zones", args: { _org_id: "org-1", _ids: [C, A, B] } },
    ]);
    expect(state.db.updates).toEqual([]);
    expect(state.db.rows.map((r: any) => [r.id, r.priority])).toEqual([
      [A, 2],
      [B, 1],
      [C, 3],
    ]);
    expect(state.redetects).toBe(1);
    expect(out.propertiesUpdated).toBe(2);
  });

  it("an id that is not the business's is refused, and nothing is written", async () => {
    state.db = fakeDb([dbZone(A, "Downtown", 3)]);
    const { reorderZones } = await import("@/lib/zones.functions");
    await expect(reorderZones({ data: { ids: [A, B] } } as any)).rejects.toThrow(
      "Zone not found.",
    );
    expect(state.db.rpcCalls).toHaveLength(0);
  });

  it("an area left out of the order is put after the ones sent; an order already in place writes nothing", async () => {
    state.db = fakeDb([dbZone(A, "Downtown", 3), dbZone(B, "Midtown", 2), dbZone(C, "Riverfront", 1)]);
    const { reorderZones } = await import("@/lib/zones.functions");
    const out = await reorderZones({ data: { ids: [B] } } as any);
    expect(out.order).toEqual([B, A, C]);
    expect(state.db.rpcCalls.map((c: any) => c.args._ids)).toEqual([[B, A, C]]);
    const again = await reorderZones({ data: { ids: [B, A, C] } } as any);
    expect(again.order).toEqual([B, A, C]);
    expect(state.db.rpcCalls).toHaveLength(1);
  });

  it("a refusal from the database is the caller's error, and nothing else is written", async () => {
    state.db = fakeDb([dbZone(A, "Downtown", 3), dbZone(B, "Midtown", 2)]);
    state.db.rpc = async () => ({
      data: null,
      error: { message: "reorder_zones: not allowed to reorder these areas" },
    });
    const { reorderZones } = await import("@/lib/zones.functions");
    await expect(reorderZones({ data: { ids: [B, A] } } as any)).rejects.toThrow(
      "not allowed to reorder these areas",
    );
    expect(state.db.updates).toEqual([]);
    expect(state.redetects).toBe(0);
  });
});

// ── The screen ─────────────────────────────────────────────────────────────

describe("the Zones page", () => {
  it("draws the ranking and the pending note, from one component the Settings move can carry", () => {
    const page = read("src/routes/_authenticated/zones.tsx");
    expect(page).toMatch(/<ZoneRankingPanel zones=\{zones as any\} canEdit=\{canEdit\} \/>/);
    expect(page).toMatch(/<ZipFillPendingNote zone=\{zone\} \/>/);
    // The typed number is gone from the card: the ranking says the order.
    expect(page).not.toMatch(/Priority \{zone\.priority\}/);
    const panel = read("src/components/ZoneRanking.tsx");
    expect(panel).toMatch(/aria-label=\{`Move \$\{z\.name\} up`\}/);
    expect(panel).toMatch(/aria-label=\{`Move \$\{z\.name\} down`\}/);
    expect(panel).toMatch(/data-testid="zone-no-zips-left"/);
    // Buttons, not a drag handle: the owner reorders on a phone too.
    expect(panel).not.toMatch(/draggable|onDragStart/);
    expect(panel).not.toMatch(/group-hover:/);
  });
});

// ── The migration, read ────────────────────────────────────────────────────

describe("the migration that ranks existing areas newest first", () => {
  const sql = read(MIGRATION);
  const code = sql
    .split("\n")
    .filter((l) => !/^\s*--/.test(l))
    .join("\n");

  it("carries the version SIC reserved for #906, above #909's and every open PR's at the time", () => {
    // 20261112030000 was reserved by SIC (review 5875669745): #909 keeps
    // 20261112020000 and #907 takes 20261112040000. main has since gained
    // 20261112050000 (#891), so "last in the directory" is no longer the
    // check; the reserved number is, and it sorts above #909's.
    const names = readdirSync(join(ROOT, "supabase/migrations")).sort();
    const mine = MIGRATION.split("/").pop()!;
    expect(names).toContain(mine);
    expect(mine.startsWith("20261112030000_")).toBe(true);
    expect(names.filter((n) => n.startsWith("20261112030000_"))).toEqual([mine]);
    expect(mine > "20261112020000").toBe(true);
  });

  it("adds the pending columns and ranks per business by creation time, newest on top", () => {
    expect(code).toMatch(
      /ALTER TABLE public\.zones ADD COLUMN IF NOT EXISTS zip_fill_pending_since timestamptz;/,
    );
    expect(code).toMatch(
      /ALTER TABLE public\.zones ADD COLUMN IF NOT EXISTS zip_fill_last_tried_at timestamptz;/,
    );
    expect(code).toMatch(/PARTITION BY z\.organization_id\s+ORDER BY z\.created_at ASC, z\.id ASC/);
    expect(code).toMatch(/SET priority = r\.rank_priority/);
  });

  it("changes nothing the second time: only a row whose priority differs is written", () => {
    expect(code).toMatch(/AND z\.priority IS DISTINCT FROM r\.rank_priority/);
  });

  it("reorders in one statement, under row-level security, and not for anon", () => {
    expect(code).toMatch(
      /CREATE OR REPLACE FUNCTION public\.reorder_zones\(_org_id uuid, _ids uuid\[\]\)/,
    );
    const fn = code.slice(code.indexOf("FUNCTION public.reorder_zones"), code.indexOf("$fn$;"));
    expect(fn).toMatch(/SECURITY INVOKER/);
    expect(fn).not.toMatch(/SECURITY DEFINER/);
    // One UPDATE over the list, not a loop.
    expect(code.match(/UPDATE public\.zones z\s+SET priority = cardinality\(_ids\)/g)).toHaveLength(1);
    expect(code).toMatch(/FROM unnest\(_ids\) WITH ORDINALITY AS o\(id, ord\)/);
    expect(code).toMatch(/the list is not this business''s areas/);
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.reorder_zones\(uuid, uuid\[\]\) FROM PUBLIC, anon;/,
    );
    expect(code).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.reorder_zones\(uuid, uuid\[\]\) TO authenticated, service_role;/,
    );
  });

  it("raises on what it establishes and only reports what it found", () => {
    expect(code).toMatch(/HAVING count\(\*\) > 1/);
    expect(code).toMatch(/RAISE EXCEPTION '\[20261112030000\] % business\/priority pair/);
    expect(code).toMatch(/RAISE WARNING '\[20261112030000\] ranked the areas of/);
  });

  it("names no business and touches no row by id", () => {
    expect(code).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
    expect(sql).not.toMatch(/Detroit Doo/i);
    expect(code).not.toMatch(/\bDELETE\b|\bTRUNCATE\b|DROP TABLE/);
  });
});

// ── The migration, proved against a real Postgres when one answers ─────────

const PROOF = join(ROOT, "tests/sql/a-ranking-settles-zip-overlaps.proof.sql");
const DB_URL =
  process.env.RANKING_PROOF_DB_URL ?? "postgresql://postgres:postgres@127.0.0.1:54422/postgres";

function findPsql(): string | null {
  for (const p of [
    "psql",
    "/opt/homebrew/opt/libpq/bin/psql",
    "/opt/homebrew/opt/postgresql@18/bin/psql",
    "/opt/homebrew/opt/postgresql@17/bin/psql",
    "/usr/local/opt/libpq/bin/psql",
  ]) {
    const r = spawnSync(p, ["--version"], { encoding: "utf8" });
    if (r.status === 0) return p;
  }
  return null;
}

const psql = findPsql();
const reachable =
  !!psql &&
  spawnSync(psql, [DB_URL, "-XAtc", "select 1"], {
    encoding: "utf8",
    timeout: 5_000,
  }).stdout?.trim() === "1";

if (!reachable) {
  console.warn(
    `\n  SKIPPED: the ranking proof did NOT run. ${psql ? `No database answered at ${DB_URL}.` : "psql was not found."}\n` +
      "  Start the local stack (supabase start) or set RANKING_PROOF_DB_URL to run it.\n",
  );
}

describe.skipIf(!reachable)("the ranking migration, in a real database", () => {
  it("has the files it runs", () => {
    expect(existsSync(join(ROOT, MIGRATION))).toBe(true);
    expect(existsSync(PROOF)).toBe(true);
  });

  it("ranks three areas newest first, per business, a second run changes nothing, and the owner's reorder lands whole", () => {
    const r = spawnSync(
      psql!,
      [DB_URL, "-X", "-v", `migration=${join(ROOT, MIGRATION)}`, "-f", PROOF],
      { encoding: "utf8", timeout: 300_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    expect(r.status, out).toBe(0);
    expect(out).not.toMatch(/PROOF FAILED/);
    expect(out.match(/NOTICE:\s+ok: /g)?.length, out).toBe(6);
    expect(out).toMatch(/ALL RANKING PROOFS PASSED/);

    const left = spawnSync(
      psql!,
      [DB_URL, "-XAtc", "select count(*) from public.organizations where name like 'Rank Proof %'"],
      { encoding: "utf8" },
    );
    expect(left.stdout.trim()).toBe("0");
  });
});
