/**
 * Every map in the product was serving CARTO's watermark.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * `map-tiles.ts` offered three base styles and defaulted to `positron`, which
 * is `basemaps.cartocdn.com/light_all`. CARTO requires an API key for that CDN
 * and this repo has never had one. What it does about it is the whole problem:
 * it does not 401, and it does not serve a blank tile. It serves the map, with
 *
 *     API KEY REQUIRED
 *     carto.com/basemaps/apikey
 *
 * stamped diagonally across every 256x256 tile. Fetched live on 2026-08-30
 * over Detroit at z12: `200 OK`, `image/png`, 23,625 bytes, watermark through
 * the middle of it.
 *
 * So the Schedule page — the busiest screen in the product — has been showing
 * customers a working map with another company's advertisement across it, and
 * it reads as our bug rather than a missing key.
 *
 * ── WHY A TEST AND NOT JUST A FIX ─────────────────────────────────────────
 *
 * The file's own header argued for CARTO on the grounds that a keyed provider
 * "silently stops drawing when a key expires or hits its quota", which is a
 * worse failure than a different palette. That reasoning was sound. The fact
 * under it — that keyless means usable — quietly stopped being true, and
 * nothing in the repo could notice, because every automated check this repo
 * has looks at source or at geometry. A watermark is neither. It is pixels
 * inside a 200 response.
 *
 * This cannot assert the pixels without a network call in the unit suite, and
 * a test that fetches a third-party CDN is a test that fails on a train. What
 * it CAN do is hold the line that was crossed: no keyless-CDN URL comes back
 * into the tile config without somebody looking at a tile first. The host is
 * named rather than pattern-matched, because the next one will not be CARTO.
 *
 * It also covers the half of the fix that is easy to forget. Removing a style
 * does not remove it from the browsers of everyone who selected it: their
 * choice is in localStorage, and a reader that simply stops recognising the
 * value would leave precisely the users who cared enough to pick one sitting
 * on the watermark forever.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Strips comments so a URL discussed in prose does not read as a URL used. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no tile host that watermarks an unkeyed request", () => {
  it("CARTO is gone from the whole of src/, not just from the tile config", () => {
    // Named host, not a generic pattern: the point is this specific CDN's
    // behaviour on an unkeyed request, which was verified by looking at a tile.
    const offenders = walk(join(root, "src"))
      .filter((f) => /cartocdn\.com/.test(codeOnly(readFileSync(f, "utf8"))))
      .map((f) => f.replace(root + "/", ""));
    expect(offenders).toEqual([]);
  });

  it("and the styles built on it are not selectable", () => {
    const code = codeOnly(read("src/lib/map-tiles.ts"));
    // Deliberately NOT a bare search for the names. The migration in
    // storedBaseStyle has to say "positron" out loud in order to discard it,
    // and a looser assertion here failed on that — flagging the fix as the
    // fault. What matters is that neither is a member of the union or an
    // offered option.
    const union = code.match(/export type TileVariant =[^;]*;/)?.[0] ?? "";
    expect(union).not.toMatch(/positron|voyager/);
    expect(code).not.toMatch(/value:\s*"(positron|voyager)"/);
  });

  it("the default is a style that draws without a key", () => {
    expect(codeOnly(read("src/lib/map-tiles.ts"))).toMatch(
      /DEFAULT_BASE_STYLE:\s*TileVariant\s*=\s*"street"/,
    );
  });
});

describe("the people who chose the broken style are moved off it", () => {
  it("a stored positron/voyager preference is discarded, not merely unmatched", () => {
    // Falling through to the default by failing to recognise the value is NOT
    // enough on its own — it leaves the stale value in localStorage to be
    // re-honoured by any future reader that adds the name back. The retired
    // names have to be named and cleared.
    const code = codeOnly(read("src/lib/map-tiles.ts"));
    expect(code).toMatch(/v === "positron" \|\| v === "voyager"/);
    expect(code).toMatch(/removeItem\("map\.baseStyle"\)/);
  });
});
