// Canvassing: the seeder invented a coordinate and Walk mode skipped a door.
//
// Both were live on 2026-09-03. The production numbers in the assertions below
// came from the demo workspace: 23 leads, 22 with a coordinate, THREE distinct
// points — one of which held six rows whose text says "New York, NY 10011"
// while the point is in Brooklyn, because the address was generated and the
// coordinate was copied from the seed client.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { orderForWalk, type WalkDoor } from "../src/lib/canvass-order";

const seeder = readFileSync("src/lib/neighbors.functions.ts", "utf8");
const page = readFileSync("src/routes/_authenticated/neighbors.tsx", "utf8");
const strip = (s: string) => s.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, "");

describe("a generated address does not get a borrowed coordinate", () => {
  it("never writes the seed client's point onto a neighbour", () => {
    // The whole fault in one line: `latitude: prop.latitude`. Comments are
    // stripped because the replacement documents the old line in order to say
    // it is gone.
    const code = strip(seeder);
    expect(code).not.toMatch(/latitude:\s*prop\.latitude/);
    expect(code).not.toMatch(/longitude:\s*prop\.longitude/);
  });

  it("asks the address provider whether each generated door exists", () => {
    const code = strip(seeder);
    expect(code).toMatch(/getAddressProvider/);
    expect(code).toMatch(/provider\.autocomplete\(candidate/);
    expect(code).toMatch(/provider\.details\(best\.id\)/);
    // Anything the provider cannot find is counted and dropped, not stored.
    expect(code).toMatch(/unresolved\+\+;\s*continue;/);
  });

  it("leaves the coordinate empty rather than guessing when there is no provider", () => {
    // A workspace with no address search still gets house numbers — a tech on
    // the footpath can read them — but an unmeasured door must not claim a
    // location, because the map, the walk order and the Navigate link all
    // treat one as measured.
    const code = strip(seeder);
    expect(code).toMatch(/let latitude: number \| null = null;/);
    expect(code).toMatch(/let longitude: number \| null = null;/);
  });

  it("does not send anyone to knock on their own customer's door", () => {
    const code = strip(seeder);
    expect(code).toMatch(/ownStreets/);
    expect(code).toMatch(/from\("properties"\)\.select\("street"\)/);
    // Nor add a door the list already has, which is what pressing Seed twice
    // used to do.
    expect(code).toMatch(/known\.has\(norm\(line\)\)/);
  });
});

describe("a door added by hand keeps the point the geocoder already found", () => {
  it("passes the resolved latitude and longitude to the server", () => {
    const code = strip(page);
    expect(code).toMatch(/latitude: addressPoint\?\.lat \?\? null/);
    expect(code).toMatch(/longitude: addressPoint\?\.lon \?\? null/);
    // And forgets it the moment the text stops matching the match.
    expect(code).toMatch(/setAddressPoint\(null\)/);
  });

  it("no longer throws the resolved address away", () => {
    // `onResolved={(r) => setAddress(r.address.formatted)}` kept one field of
    // an object that carried the coordinate too.
    expect(strip(page)).not.toMatch(/onResolved=\{\(r\) => setAddress\(r\.address\.formatted\)\}/);
  });
});

describe("walk mode visits every door once", () => {
  it("does not advance past the door that slid into this position", () => {
    // interested / passed / signed up all REMOVE the door from the queue. The
    // old code also did `setWalkIdx(i => i + 1)`, so the list shifted down by
    // one and the index moved up by one and the next house was never shown.
    const code = strip(page);
    expect(code).toMatch(/const answer = \(status: NeighborLead\["status"\]\) => \{/);
    expect(code).not.toMatch(/status: "interested" \}\);\s*setWalkIdx/);
    expect(code).not.toMatch(/status: "converted" \}\);\s*setWalkIdx/);
    expect(code).not.toMatch(/status: "not_interested" \}\);\s*setWalkIdx/);
  });

  it("cannot skip off the end of the queue", () => {
    expect(strip(page)).toMatch(/Math\.min\(i \+ 1, walkQueue\.length - 1\)/);
  });
});

describe("the walk order is geographic, not the order somebody typed them", () => {
  const d = (id: string, address_line: string, lat?: number, lon?: number): WalkDoor => ({
    id,
    address_line,
    latitude: lat ?? null,
    longitude: lon ?? null,
  });

  it("chains mapped doors nearest to nearest instead of by insertion", () => {
    // Two streets, interleaved the way `created_at DESC` interleaves them.
    // Austin's Bouldin Ave and a point five kilometres away.
    const doors = [
      d("a1", "1414 Bouldin Ave", 30.2517, -97.7584),
      d("b1", "6397 Manchaca Rd", 30.2079, -97.8052),
      d("a2", "1416 Bouldin Ave", 30.2519, -97.7584),
      d("b2", "6399 Manchaca Rd", 30.2081, -97.8052),
      d("a3", "1418 Bouldin Ave", 30.2521, -97.7584),
    ];
    const ids = orderForWalk(doors).map((x) => x.id);
    // Whatever the chain picks first, it finishes one street before the other.
    const firstStreet = ids[0].startsWith("a") ? "a" : "b";
    const switchAt = ids.findIndex((x) => !x.startsWith(firstStreet));
    expect(ids.slice(0, switchAt).every((x) => x.startsWith(firstStreet))).toBe(true);
    expect(ids.slice(switchAt).every((x) => !x.startsWith(firstStreet))).toBe(true);
  });

  it("puts doors with no location last, grouped by street and in number order", () => {
    const doors = [
      d("u3", "1418 Bouldin Ave, Austin, TX"),
      d("m1", "6397 Manchaca Rd", 30.2079, -97.8052),
      d("u1", "1414 Bouldin Ave, Austin, TX"),
      d("u2", "6401 Manchaca Rd, Austin, TX"),
    ];
    expect(orderForWalk(doors).map((x) => x.id)).toEqual(["m1", "u1", "u3", "u2"]);
  });

  it("keeps a line with no house number rather than dropping it", () => {
    const doors = [d("x", "The cottage behind the church"), d("y", "12 Elm St")];
    expect(orderForWalk(doors).map((x) => x.id).sort()).toEqual(["x", "y"]);
  });

  it("returns every door it was given, exactly once", () => {
    const doors = [
      d("a", "1 A St", 30.2, -97.7),
      d("b", "2 A St"),
      d("c", "3 A St", 30.3, -97.8),
      d("d", "4 B St"),
    ];
    const out = orderForWalk(doors);
    expect(out).toHaveLength(4);
    expect(new Set(out.map((x) => x.id)).size).toBe(4);
  });
});
