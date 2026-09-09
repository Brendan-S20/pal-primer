import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The zones page reported "54 properties carry a zone the rules would no longer
// give them" and offered no way to act on it.
//
// `redetectZonesForOrg` already existed, but every call site was
// `redetectBestEffort` inside zones.functions.ts, fired as a side effect of
// creating, editing or deleting a zone. So the only way to run it deliberately
// was to open an unrelated zone and re-save it, and `redetectBestEffort`
// swallows its own failure -- meaning that workaround could do nothing at all
// and say nothing about it.
//
// `rerunZoneDetection` is the same operation made deliberate. Two properties
// distinguish it from the side-effect version, and both are easy to lose to a
// well-meaning refactor that "makes it consistent with the other one", so they
// are pinned here rather than left to a comment.

const SRC = readFileSync(
  join(process.cwd(), "src/lib/zone-coverage.functions.ts"),
  "utf8",
);

/**
 * The body of one exported server function, by name, WITH COMMENTS STRIPPED.
 *
 * Stripping matters and this test learned it the hard way: the slice runs to
 * the next `export const`, so it sweeps in the comment block that introduces
 * the following function. The first version of the "getZoneCoverage does not
 * write" assertion failed on prose describing redetectZonesForOrg rather than
 * on any call to it. Every assertion below is about what the code DOES, so
 * none of them should be able to match a sentence about it -- the try/catch
 * check especially, which would otherwise trip on the word "swallowing".
 */
function bodyOf(name: string): string {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const start = code.indexOf(`export const ${name} =`);
  expect(start, `${name} is not exported from zone-coverage.functions.ts`).toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const next = rest.indexOf("\nexport const ");
  return next === -1 ? rest : rest.slice(0, next);
}

describe("the button that acts on the warning", () => {
  const body = bodyOf("rerunZoneDetection");

  it("is gated on the same permission as editing a zone", () => {
    // It rewrites properties.zone_id across the organization. A dispatcher who
    // can see the zones page must not be able to reassign the whole book.
    expect(body).toMatch(/requirePermission\(\s*supabase,\s*userId,\s*"manage_pricing"\s*\)/);
  });

  it("does not resolve the org with the unguarded helper", () => {
    // resolveCaller answers "which org" and asks nothing about permission.
    // Using it here would authenticate without authorizing.
    const guarded = body.slice(body.indexOf("handler"));
    expect(guarded).not.toMatch(/resolveCaller\(/);
  });

  it("lets the failure reach the person who pressed the button", () => {
    // The mutation this guards: copying redetectBestEffort's try/catch, which
    // returns 0 on failure. That reports "nothing needed changing" and "the
    // write failed" with the same words, on a button whose whole purpose is
    // fixing something the user was just told is wrong.
    expect(body).not.toMatch(/\btry\s*\{/);
    expect(body).not.toMatch(/\bcatch\s*\(/);
  });

  it("returns what it actually changed rather than a bare ok", () => {
    expect(body).toMatch(/propertiesUpdated/);
  });
});

describe("the read side stays a read", () => {
  it("getZoneCoverage does not write", () => {
    const body = bodyOf("getZoneCoverage");
    expect(body).not.toMatch(/\.update\(|\.insert\(|\.upsert\(|\.delete\(/);
    expect(body).not.toMatch(/redetectZonesForOrg/);
  });
});

describe("the confirm says what will change before it changes it", () => {
  const PAGE = readFileSync(
    join(process.cwd(), "src/routes/_authenticated/zones.tsx"),
    "utf8",
  );

  it("states the count that will lose its zone", () => {
    // On the real organization this clears 54 assignments. A confirm that said
    // only "re-run detection?" would be asking permission for something the
    // person cannot see the size of.
    expect(PAGE).toMatch(/will lose the zone they currently show/);
  });

  it("warns that this makes properties agree with the zones, not the reverse", () => {
    // The failure mode worth naming: if the ZONES are the thing that is wrong,
    // re-running detection propagates the mistake instead of fixing it.
    expect(PAGE).toMatch(/If the zones themselves are wrong, fix those first/);
  });

  it("only offers the button to someone allowed to press it", () => {
    expect(PAGE).toMatch(/canEdit && coverage\.summary\.stale > 0/);
  });

  it("keeps the button at a touchable size", () => {
    const i = PAGE.indexOf("Re-run zone detection");
    expect(i).toBeGreaterThan(-1);
    expect(PAGE.slice(Math.max(0, i - 900), i)).toMatch(/min-h-\[44px\]/);
  });
});
