// Three people talk about the same bin. Two of them had the same name for it.
//
// `stationDisplayName(station_number, label)` is how a waste station is named
// everywhere in the staff app: "Station 3", "Station 3 · By the west gate", or
// the label alone when there is no number. BUG-10 dropped `NOT NULL` from
// `waste_stations.label` for precisely that reason — the brief's own note says
// "every reader in the app already treated the column as optional
// (`stationDisplayName(1, null)` → "Station 1"); only the schema disagreed."
//
// The portal was the reader nobody counted. `portal_list_stations` did not
// return `station_number`, so `StationsPanel` rendered `{s.label}` on its own:
// after BUG-10 an empty heading with a location description hanging underneath
// belonging to nothing, and before it, whatever junk an import had left.
//
// The customer is the third party to that conversation. They are the one who
// says "the bin by the west gate hasn't been emptied" — and they were the only
// one holding a different set of names.
//
// ── THE ORDER MATTERS AS MUCH AS THE NAME ────────────────────────────────
//
// `listStations` orders sort_order → station_number → label. The portal ordered
// sort_order → label. On a live demo property today station_number runs 3, 2, 1
// against sort_order 1, 2, 3, so counting down the customer's list to "the
// third one" reached a different bin than the tech's station 3. Both now order
// identically, and the number is on screen so nobody has to count.
//
// ── WHY `capacity_liners` IS TESTED FOR ABSENCE ──────────────────────────
//
// `stations.functions.ts` stopped writing it in QA round 8 and says so in a
// comment; the staff editor stopped showing it. The portal kept printing
// "Capacity: 200 liners" from whatever the seed had left. A number nobody can
// change and nobody maintains is worse than a missing one, because it reads as
// current — so its absence is the assertion, and it has to stay absent.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  migrationFiles,
  readMigration,
  statements,
  stripLineComments,
} from "./support/sql-migrations";

const ROOT = new URL("..", import.meta.url).pathname;
// Lazy: a read resolved in a describe body turns a missing file into an
// import-time throw, and vitest reports that as "no tests" — which reads as a
// pass. The mutation test for this file stashes src/ and supabase/.
const portalUi = () => readFileSync(ROOT + "src/lib/portal-ui.tsx", "utf8");
const portalFns = () => readFileSync(ROOT + "src/lib/portal.functions.ts", "utf8");
const staffFns = () => readFileSync(ROOT + "src/lib/stations.functions.ts", "utf8");

/** The last CREATE FUNCTION for `name` across the whole directory — what the
 *  database has after the migrations run. A grep would find the 2026-07 file
 *  that first wrote this function and report a bug that no longer exists. */
function effective(name: string): string {
  let found: string | null = null;
  for (const file of migrationFiles()) {
    for (const st of statements(stripLineComments(readMigration(file)))) {
      if (
        new RegExp(
          String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.${name}\s*\(`,
          "i",
        ).test(st)
      )
        found = st;
    }
  }
  if (!found) throw new Error(`${name} has no CREATE FUNCTION in supabase/migrations`);
  return found;
}

/** `StationsPanel`'s body, brace-matched. Regex cannot do it: the component is
 *  nested JSX and a lazy match to the next `\n}` stops inside the first block. */
function stationsPanel(src: string): string {
  const start = src.indexOf("export function StationsPanel(");
  if (start === -1) throw new Error("StationsPanel not found in portal-ui.tsx");
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  throw new Error("unbalanced braces in StationsPanel");
}

describe("the portal names a station the way the crew does", () => {
  it("returns the number the name is built from", () => {
    expect(effective("portal_list_stations")).toMatch(/station_number integer/i);
  });

  it("renders it through the one helper, not the raw label", () => {
    const panel = stationsPanel(portalUi());
    expect(
      panel,
      "label is nullable since BUG-10, so rendering it alone leaves a blank " +
        "heading above a location description belonging to nothing",
    ).toMatch(/stationDisplayName\(s\.station_number, s\.label\)/);
    expect(portalUi()).toMatch(/import \{ stationDisplayName \} from "@\/lib\/dna-linkage"/);
  });

  it("uses the same helper the staff panel does, rather than a second copy", () => {
    // If someone re-implements the naming here, the two screens drift again
    // and this test goes green while the bug returns.
    const panel = stationsPanel(portalUi());
    expect(panel).not.toMatch(/Station \$\{/);
    expect(panel).not.toMatch(/`Station /);
  });

  it("orders exactly as listStations does, so the numbers line up", () => {
    expect(effective("portal_list_stations")).toMatch(
      /ORDER BY ws\.sort_order, ws\.station_number, ws\.label/i,
    );
    // The staff side of the same claim. If this ever changes, the two lists
    // disagree again and this pins which one moved.
    const staff = staffFns();
    const listStations = staff.slice(staff.indexOf("export const listStations"));
    expect(listStations).toMatch(
      /\.order\("sort_order"\)\s*\n?\s*\.order\("station_number"\)\s*\n?\s*\.order\("label"\)/,
    );
  });
});

describe("the portal stops printing a number nobody maintains", () => {
  it("does not return capacity_liners", () => {
    expect(effective("portal_list_stations")).not.toMatch(/capacity_liners/i);
  });

  it("does not render it either, in the panel or the handler's type", () => {
    expect(stationsPanel(portalUi())).not.toMatch(/Capacity:/);
    const fns = portalFns();
    const handler = fns.slice(
      fns.indexOf("export const portalListStations"),
      fns.indexOf("export const portalListMyRequests"),
    );
    expect(handler).not.toMatch(/capacity_liners/);
    expect(handler).toMatch(/station_number: number \| null/);
  });

  it("still says why, where the writer stopped writing it", () => {
    // The reason this is dead rather than merely unused. If this comment goes,
    // someone will helpfully wire capacity back up.
    expect(staffFns()).toMatch(/capacity_liners is intentionally no longer written/i);
  });

  it("keeps liner_size, which is still written and still shown to staff", () => {
    // Not everything on that row was stale; deleting the maintained field
    // alongside the unmaintained one would be the opposite mistake.
    expect(effective("portal_list_stations")).toMatch(/liner_size text/i);
    expect(staffFns()).toMatch(/liner_size: data\.linerSize/);
  });
});

describe("the migration says what it found and proves what it changed", () => {
  const FILE = "20260812150000_the-portal-called-them-something-the-crew-had-never-heard-of.sql";

  it("asserts the state it expects before dropping anything", () => {
    const sql = readMigration(FILE);
    expect(sql).toMatch(/do \$pre\$/i);
    expect(sql).toMatch(/already returns station_number/);
    // The fix only makes sense while label can be null.
    expect(sql).toMatch(/label is NOT NULL again/);
  });

  it("revokes all three grants a re-signatured function arrives with", () => {
    // A DROP and CREATE mints a fresh ACL. The migration two before this one
    // revoked PUBLIC and anon and left `authenticated`, because the lockdown
    // test polices the first two and nothing polices the third.
    const sql = stripLineComments(readMigration(FILE));
    expect(sql).toMatch(
      /revoke all on function public\.portal_list_stations\(uuid\) from public, anon/i,
    );
    expect(sql).toMatch(
      /revoke execute on function public\.portal_list_stations\(uuid\) from authenticated/i,
    );
    expect(sql).toMatch(/reachable without service_role/);
  });

  it("proves the new shape from the catalog rather than asserting it", () => {
    const sql = readMigration(FILE);
    const post = sql.slice(sql.indexOf("do $post$"));
    expect(post).toMatch(/pg_get_functiondef/);
    expect(post).toMatch(/still does not return the station number/);
    expect(post).toMatch(/still returns the unmaintained capacity/);
    expect(post).toMatch(/does not order the way listStations does/);
  });
});
