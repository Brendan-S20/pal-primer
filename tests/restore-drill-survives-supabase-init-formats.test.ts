// supabase CLI v3.4.0 (2026-11-24) changed `supabase init` to write
// supabase/config.jsonc instead of supabase/config.toml. drill.sh read the
// toml by a relative path and died with ENOENT, which turned the Sandboxes
// restore-drill self-test red on main. The drill runs on the CLI's `latest`
// on purpose (its auth and storage schemas must be at least as new as
// production's), so it has to cope with either file rather than pin one CLI.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { patchStackDir } from "../scripts/backup/patch-drill-config.mjs";

const TOML = `[api]\nport = 54321\n[db]\nport = 54322\nshadow_port = 54320\nmajor_version = 15\n[db.pooler]\nport = 54329\n`;
const JSONC = `{\n  "api": {\n    "port": 54321,\n  },\n  "db": {\n    "port": 54322,\n    "shadow_port": 54320,\n    // "smtp_port": 54325,\n    "major_version": 15,\n    "pooler": { "port": 54329 }\n  }\n}\n`;

const stack = (file: string, body: string) => {
  const dir = mkdtempSync(join(tmpdir(), "drill-config-"));
  mkdirSync(join(dir, "supabase"));
  writeFileSync(join(dir, "supabase", file), body);
  return dir;
};

describe("drill stack config patching", () => {
  it("patches config.toml (CLI up to v3.3.0)", () => {
    const dir = stack("config.toml", TOML);
    expect(patchStackDir(dir, "547", "17")).toEqual({ file: "config.toml", ports: 4 });
    const s = readFileSync(join(dir, "supabase", "config.toml"), "utf8");
    expect(s).toContain("port = 54721");
    expect(s).toContain("major_version = 17");
    expect(s).not.toMatch(/543\d\d/);
  });

  it("patches config.jsonc (CLI v3.4.0 and later), keeping the comma", () => {
    const dir = stack("config.jsonc", JSONC);
    expect(patchStackDir(dir, "547", "17").file).toBe("config.jsonc");
    const s = readFileSync(join(dir, "supabase", "config.jsonc"), "utf8");
    expect(s).toContain('"port": 54722,');
    expect(s).toContain('"major_version": 17,');
    expect(s).not.toMatch(/\b543\d\d\b/);
  });

  it("fails loudly, never silently, when init left no config or a changed one", () => {
    const empty = mkdtempSync(join(tmpdir(), "drill-config-"));
    mkdirSync(join(empty, "supabase"));
    expect(() => patchStackDir(empty, "547", "17")).toThrow(/left neither/);
    expect(() => patchStackDir(stack("config.toml", "[api]\nport = 1\n"), "547", "17")).toThrow(
      /major_version|543xx/,
    );
    expect(() => patchStackDir(stack("config.toml", "major_version = 15\n"), "547", "17")).toThrow(
      /543xx/,
    );
  });

  it("drill.sh uses the patcher, not a hard-coded config.toml path", () => {
    const sh = readFileSync(join(__dirname, "..", "scripts/backup/drill.sh"), "utf8");
    expect(sh).toContain("patch-drill-config.mjs");
    expect(sh).not.toMatch(/readFileSync\(path/);
  });
});
