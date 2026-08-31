// Tile hosts that need a key, in a file whose whole premise was that none of
// them did.
//
// CARTO's Positron was the DEFAULT basemap and it spent an unknown period
// serving "API KEY REQUIRED  carto.com/basemaps/apikey" stamped diagonally
// across every tile. It failed worse than the failure the file was designed
// around: the map kept drawing, so no error surfaced anywhere, and the only
// way to see it was to look at a rendered map.
//
// This cannot check what a tile LOOKS like without fetching one, and a test
// that reaches the network is a test that fails on a train. What it can do is
// keep the app off hosts that are known to require a key, which is the
// decision that went wrong: nobody chose to ship a watermark, somebody chose a
// host whose terms changed underneath them.
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

/** Hosts that serve degraded or watermarked tiles without an API key.
 *  Add to this when one is found; do not remove without a rendered tile. */
const KEYED_TILE_HOSTS = [
  { host: "basemaps.cartocdn.com", why: "watermarks every tile without api_key (seen 2026-08-31)" },
  { host: "api.maptiler.com", why: "requires ?key=" },
  { host: "api.mapbox.com", why: "requires access_token" },
  { host: "tiles.stadiamaps.com", why: "requires an API key outside localhost" },
  { host: "tile.thunderforest.com", why: "requires apikey" },
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("no basemap that needs a key we do not have", () => {
  const files = walk(SRC);

  for (const { host, why } of KEYED_TILE_HOSTS) {
    it(`does not fetch tiles from ${host}`, () => {
      const hits = files.filter((f) => codeOnly(readFileSync(f, "utf8")).includes(host));
      expect(
        hits.map((f) => relative(ROOT, f)),
        `${host} ${why}. A tile host that degrades without a key fails silently: ` +
          `the map still draws, so nothing alerts and only a human looking at it notices.`,
      ).toEqual([]);
    });
  }

  // Nominatim is the same shape of dependency as the basemap: free, keyless,
  // governed by a usage policy, and it degrades rather than erroring. The
  // policy asks for a descriptive User-Agent and one request a second, and a
  // BROWSER can honour neither -- fetch() forbids setting User-Agent, and every
  // tab is its own process with nothing to throttle through. So the browser
  // must not call it at all; src/lib/geocode.functions.ts is the way through.
  it("never geocodes straight from the browser", () => {
    const offenders = files
      .filter((f) => !/\.server\.ts$/.test(f))
      .filter((f) => /nominatim\.openstreetmap\.org/.test(codeOnly(readFileSync(f, "utf8"))))
      .map((f) => relative(ROOT, f));
    expect(
      offenders,
      "these reach Nominatim from client code. They cannot send the User-Agent " +
        "its policy requires, they share no throttle, and the request comes from " +
        "the tenant's own IP. Call lookupAddressPoint from geocode.functions.ts.",
    ).toEqual([]);
  });

  // Leaflet's default marker images were pointed at unpkg.com. Nothing fetched
  // them -- all eleven L.marker() calls pass their own icon -- so it was a
  // SAFETY NET for a marker created without one, not a live dependency. A net
  // that reaches for a CDN is no net at all in a van with no signal, which is
  // the condition this app exists to survive. They are imported and bundled
  // now (Vite inlines all three; each is under the 4KB limit).
  it("hotlinks no CDN for an asset it already ships", () => {
    const CDNS = ["unpkg.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"];
    const offenders: string[] = [];
    for (const f of files) {
      const src = codeOnly(readFileSync(f, "utf8"));
      for (const cdn of CDNS) if (src.includes(cdn)) offenders.push(`${relative(ROOT, f)} -> ${cdn}`);
    }
    expect(
      offenders,
      "this app bundles its dependencies, so a runtime CDN fetch is an outage " +
        "and an offline failure it does not need to own.",
    ).toEqual([]);
  });

  it("offers only styles it can actually draw, and defaults to one of them", () => {
    // Read rather than imported: map-tiles.ts imports Leaflet, which touches
    // `window` at module scope and throws in a node environment. Importing it
    // would mean giving this file a jsdom environment to answer a question
    // about a string literal.
    const src = codeOnly(readFileSync(join(SRC, "lib/map-tiles.ts"), "utf8"));
    const block = /export const BASE_STYLES[\s\S]*?\n\];/.exec(src)?.[0] ?? "";
    expect(block, "BASE_STYLES not found").not.toBe("");
    const offered = [...block.matchAll(/value:\s*"([a-z]+)"/g)].map((m) => m[1]);
    expect(offered.length).toBeGreaterThan(0);
    const def = /export const DEFAULT_BASE_STYLE: TileVariant = "([a-z]+)"/.exec(src)?.[1];
    expect(def, "DEFAULT_BASE_STYLE not found").toBeTruthy();
    expect(offered, `the default basemap "${def}" is not one of the styles on offer`).toContain(
      def,
    );
  });

  it("retires a stored preference for a style no longer offered", () => {
    // The tiles were the broken thing, not the preference. Without this every
    // user who had ever opened the picker would keep their watermarked choice.
    const src = codeOnly(readFileSync(join(SRC, "lib/map-tiles.ts"), "utf8"));
    expect(src).toMatch(/BASE_STYLES\.some\(/);
    expect(src, "storedBaseStyle still hard-codes the accepted values").not.toMatch(
      /v === "positron"|v === "voyager"/,
    );
  });
});
