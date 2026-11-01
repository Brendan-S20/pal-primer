import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error plain ESM script, no types
import { findProdHosts } from "../scripts/native-prod-hosts.mjs";

// #623. Until this, src/integrations/supabase/client.ts read VITE_SUPABASE_URL
// only in `vite dev`, so every native build, staging included, used the
// production Supabase project. The URL is now a build-time setting beside
// NATIVE_API_ORIGIN, and a staging build fails if its bundle names a
// production host. These pin the pieces a regeneration of client.ts or an
// edit to the build script could quietly drop.

const code = (p: string) => readFileSync(p, "utf8").replace(/^\s*\/\/.*$/gm, "");

describe("the Supabase URL is a native build setting", () => {
  it("client.ts reads the native settings before the production literals", () => {
    const src = code("src/integrations/supabase/client.ts");
    expect(src).toMatch(
      /import\.meta\.env\.HS_NATIVE_SUPABASE_URL\s*\|\|\s*\n?\s*"https:\/\/api\.houndstack\.com"/,
    );
    expect(src).toMatch(
      /import\.meta\.env\.HS_NATIVE_SUPABASE_PUBLISHABLE_KEY\s*\|\|\s*\n?\s*"eyJ/,
    );
  });

  it("vite.config.ts defines them for the native build only, under a non-VITE_ name", () => {
    const cfg = code("vite.config.ts");
    expect(cfg).toMatch(
      /"import\.meta\.env\.HS_NATIVE_SUPABASE_URL":\s*JSON\.stringify\(NATIVE_SUPABASE_URL\)/,
    );
    expect(cfg).toMatch(/const NATIVE_SUPABASE_URL = NATIVE_BUILD \?/);
    // A VITE_ name would be filled from the environment in the web build too.
    expect(cfg).not.toMatch(/VITE_NATIVE_SUPABASE/);
  });

  it("vite.config.ts refuses a staging build that names a production host", () => {
    const cfg = code("vite.config.ts");
    expect(cfg).toMatch(/NATIVE_SUPABASE_URL is a production host/);
    expect(cfg).toMatch(/NATIVE_API_ORIGIN is a production host/);
  });

  it("build:native:staging scans the bundle after building it", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));
    expect(pkg.scripts["build:native:staging"]).toBe("node scripts/build-native.mjs --staging");
    const build = code("scripts/build-native.mjs");
    expect(build).toMatch(/NATIVE_TARGET\s*===\s*"staging"[\s\S]*assertNoProdHosts\(/);
  });
});

describe("findProdHosts", () => {
  let dir = "";
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  function bundle(files: Record<string, string>) {
    dir = mkdtempSync(join(tmpdir(), "native-bundle-"));
    mkdirSync(join(dir, "assets"));
    const base = {
      "index.html": "<html></html>",
      "assets/a.js": "",
      "assets/b.js": "",
      "assets/c.css": "",
      "assets/d.json": "{}",
    };
    for (const [name, body] of Object.entries({ ...base, ...files }))
      writeFileSync(join(dir, name), body);
    return dir;
  }

  it("passes a bundle that names only staging, and leaves email addresses alone", () => {
    const d = bundle({
      "assets/a.js": 'fetch("https://staging.example.test/x");mailto:support@houndstack.com',
    });
    expect(findProdHosts(d)).toEqual([]);
  });

  it.each([
    ["the Supabase host", 'createClient("https://api.houndstack.com")'],
    ["the web app", "const o=`https://app.houndstack.com`"],
    ["a bare hostname", 'u.hostname!=="app.houndstack.com"'],
    ["the marketing site", '<a href="https://houndstack.com">'],
    ["the production project ref", '"https://vsxzrbxublqrcfnxfwcu.supabase.co"'],
  ])("fails a bundle that names %s", (_label, body) => {
    expect(findProdHosts(bundle({ "assets/a.js": body }))).toHaveLength(1);
  });

  it("refuses to pass an empty directory", () => {
    dir = mkdtempSync(join(tmpdir(), "native-bundle-"));
    expect(findProdHosts(dir)).toHaveLength(1);
  });
});
