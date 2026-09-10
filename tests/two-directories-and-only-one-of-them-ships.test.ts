// /sw.js answered 404 in production for three weeks because of two directories.
//
// ── THE FAULT ──────────────────────────────────────────────────────────────
//
// `@lovable.dev/vite-tanstack-config` branches on whether it is running inside
// the hosted build environment, and in that branch overrides Nitro's output
// paths (its dist/index.js, inside `if (isSandbox)`):
//
//     nitroOpts.output = { dir: "dist", serverDir: "dist/server", publicDir: "dist/client" }
//
// Outside it, Nitro's cloudflare-module defaults give `.output/public`. So the
// directory that gets deployed is `dist/client` on the host and
// `.output/public` on a laptop, and vite.config.ts hardcoded the second.
//
// Everything that goes through Rollup, or through Nitro's own copy of
// `public/`, follows Nitro and shipped. The two files vite-plugin-pwa writes
// DIRECTLY TO DISK in `closeBundle` follow its `outDir` option, so on the host
// they landed in a directory the build never even created.
//
// Reproduced with `LOVABLE_SANDBOX=1 npx vite build` before the fix:
//
//     dist/client/      assets, manifest.webmanifest, favicon.ico, ...  (no sw.js)
//     .output/public/   sw.js, workbox-<hash>.js                        (nothing else)
//
// ── WHY EVERY EXISTING CHECK STAYED GREEN ──────────────────────────────────
//
// check-pwa-output.mjs read `.output/public`, which on a laptop is right and on
// the host is precisely the orphaned directory. It was measuring the one place
// guaranteed to look correct. `check:pwa:live` saw the 404 and reported it
// accurately for weeks, but it cannot say WHY, and "the build is fine, the
// host does not serve it" is exactly the wrong conclusion to have drawn.
//
// ── WHAT IS PINNED HERE AND WHAT IS NOT ────────────────────────────────────
//
// The value cannot be asserted from a test: which directory is deployed is a
// property of the environment the build runs in, and a unit test runs in
// neither. What CAN be pinned is that the repo no longer hardcodes one
// directory, that it derives both cases, and that something compares the guess
// against the resolved truth at build time. The last of those is the only
// durable protection, because it is the only one that survives the wrapper
// changing its mind.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const viteConfig = read("vite.config.ts");
const buildCheck = read("scripts/check-pwa-output.mjs");

describe("the worker follows the directory that ships", () => {
  it("does not hardcode a single output directory for the PWA", () => {
    // The precise regression: `outDir: NATIVE_BUILD ? ... : ".output/public"`.
    // A literal in the VitePWA options is the fault, whichever literal it is.
    const pwaBlock = viteConfig.slice(viteConfig.indexOf("VitePWA({"));
    expect(pwaBlock).not.toMatch(/outDir:\s*[^,\n]*"\.output\/public"/);
    expect(pwaBlock).toMatch(/outDir:\s*PWA_OUT_DIR/);
  });

  it("derives the hosted directory as well as the local one", () => {
    expect(viteConfig).toMatch(/HOSTED_BUILD/);
    expect(viteConfig).toMatch(/LOVABLE_SANDBOX/);
    expect(viteConfig).toMatch(/DEV_SERVER__PROJECT_PATH/);
    expect(viteConfig).toMatch(/"dist\/client"/);
    // The native build has a third answer again, and it is not the same as
    // either: no Nitro runs there at all.
    expect(viteConfig).toMatch(/"dist-native\/client"/);
  });
});

describe("and the guess is checked against the resolved truth", () => {
  // THIS IS THE PART THAT MATTERS. Deriving the environment test a third time
  // is what caused the original fault -- two places disagreeing about a path,
  // silently. The derivation is only survivable because a mismatch now ends
  // the build instead of shipping a 404 nobody notices.
  it("compares the PWA outDir against the client environment's resolved outDir", () => {
    expect(viteConfig).toMatch(/environments\??\.\s*\n?\s*client|environments\?\.client/);
    expect(viteConfig).toMatch(/configResolved/);
  });

  it("fails the build on a mismatch rather than warning", () => {
    const guard = viteConfig.slice(viteConfig.indexOf("theWorkerHasToLandWhereTheClientBuildDoes"));
    expect(guard).toMatch(/throw new Error/);
  });

  it("says so loudly when it could not run, instead of passing quietly", () => {
    // A check that cannot read the resolved value has not verified anything,
    // and "no experiment was run" must never look like "the experiment
    // passed" -- the same rule the migration section of CLAUDE.md states.
    const guard = viteConfig.slice(viteConfig.indexOf("theWorkerHasToLandWhereTheClientBuildDoes"));
    expect(guard).toMatch(/console\.warn/);
  });
});

describe("the build check inspects the tree that was actually built", () => {
  it("locates the output directory from nitro.json, not from an env var", () => {
    // Deriving the environment test here too was tried and was wrong within a
    // minute: after a hosted build BOTH directories exist, and "whichever
    // exists" picked the orphan, which held two files and passed. nitro.json
    // is written by Nitro into the tree it produced, so it names the deployed
    // one from the build itself.
    expect(buildCheck).toMatch(/nitro\.json/);
    expect(buildCheck).toMatch(/\.output\/public/);
    expect(buildCheck).toMatch(/dist\/client/);
  });

  it("reports a stray worker as the fault it is", () => {
    // "sw.js is missing" and "sw.js is in the directory nothing deploys" have
    // very different fixes, and the second is the one that actually happened.
    expect(buildCheck).toMatch(/does not deploy/);
  });
});
