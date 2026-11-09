// #741 — the Supabase Preview check failed on every main commit, and could
// never have passed.
//
// The Supabase GitHub integration compares production's migration ledger with
// supabase/migrations/ BY VERSION. Lovable and the MCP apply tool each stamp a
// new version when they apply a file, so production's versions do not match
// the filenames' prefixes: on 2026-11-08, 389 of 474 ledger versions matched no
// file. scripts/check-migrations.mjs compares by NAME for that reason, and it
// is the drift check this repo trusts.
//
// The fix is a [remotes.production] block in supabase/config.toml that turns
// migrations off for the integration's production target only. This test pins
// the four properties that make that block safe:
//
//   1. It matches production's ref and turns `db.migrations.enabled` off.
//   2. The BASE config does not turn migrations off. If it did, the empty-
//      database replay (sandboxes.yml's database job, `npm run test:e2e`,
//      `supabase db reset`) would quietly replay nothing and still pass.
//   3. The block declares nothing else. A matching [remotes.*] block also turns
//      on the integration's Configure step for that project, so anything
//      hosted-looking added here (auth, api, storage, db settings) could be
//      pushed to production on the next main commit. Adding one should be a
//      decision someone makes after a read-only `supabase config diff`, not a
//      side effect of editing this file.
//   4. sandboxes.yml rewrites the FIRST `^project_id = "…"` line to give CI its
//      own stack. That must stay the top-level one, never the remote's,
//      otherwise CI would rename production's ref and leave its own stack on
//      the developer's project id.
//
// The parser below handles only what config.toml uses (tables, `key = "str"`,
// `key = bool|number`), and fails on any other line rather than guessing.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PRODUCTION_REF = "vsxzrbxublqrcfnxfwcu";
const CONFIG_PATH = join(__dirname, "..", "supabase", "config.toml");
const config = readFileSync(CONFIG_PATH, "utf8");

type Scalar = string | boolean | number;

/** Flat map of "table.path.key" → value. Top-level keys have no prefix. */
function parseFlatToml(src: string): Map<string, Scalar> {
  const out = new Map<string, Scalar>();
  let table = "";
  src.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, "").trim();
    if (line === "" || line.startsWith("#")) return;
    const header = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (header) {
      table = header[1];
      return;
    }
    const kv = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) throw new Error(`config.toml:${i + 1}: line this test cannot read: ${raw}`);
    const [, key, rawValue] = kv;
    let value: Scalar;
    if (/^"[^"]*"$/.test(rawValue)) value = rawValue.slice(1, -1);
    else if (rawValue === "true" || rawValue === "false") value = rawValue === "true";
    else if (/^-?\d+$/.test(rawValue)) value = Number(rawValue);
    else throw new Error(`config.toml:${i + 1}: value this test cannot read: ${raw}`);
    out.set(table ? `${table}.${key}` : key, value);
  });
  return out;
}

const parsed = parseFlatToml(config);

/** Every remote whose project_id is production's ref. */
const productionRemotes = [...parsed.entries()]
  .filter(([k, v]) => /^remotes\.[^.]+\.project_id$/.test(k) && v === PRODUCTION_REF)
  .map(([k]) => k.split(".")[1]);

describe("the Supabase integration does not migrate production (#741)", () => {
  it("declares exactly one remote for production's ref", () => {
    expect(productionRemotes).toHaveLength(1);
  });

  it("turns migrations off for that remote", () => {
    const [name] = productionRemotes;
    expect(parsed.get(`remotes.${name}.db.migrations.enabled`)).toBe(false);
  });

  it("leaves migrations on for the base config, so the empty-database replay still replays", () => {
    // Absent means the CLI default, which is enabled.
    expect(parsed.get("db.migrations.enabled") ?? true).toBe(true);
  });

  it("declares nothing else for production, so the Configure step has nothing to push", () => {
    const [name] = productionRemotes;
    const declared = [...parsed.keys()].filter((k) => k.startsWith(`remotes.${name}.`)).sort();
    expect(declared).toEqual([
      `remotes.${name}.db.migrations.enabled`,
      `remotes.${name}.project_id`,
    ]);
  });

  it("keeps the top-level project_id as the line sandboxes.yml rewrites for CI", () => {
    // The same regex the "Give this job its own Supabase ports and project id"
    // step uses. String.replace without /g rewrites the first match only.
    const first = /^project_id = "([^"]+)"/m.exec(config);
    expect(first).not.toBeNull();
    const before = config.slice(0, first!.index);
    expect(before).not.toMatch(/^\[/m); // still above every table header
    // And the remote's own project_id cannot be what that regex finds.
    expect(config.match(/^project_id = "/gm)).toHaveLength(1);
  });

  it("sandboxes.yml still rewrites project_id with the regex this test assumes", () => {
    const workflow = readFileSync(
      join(__dirname, "..", ".github", "workflows", "sandboxes.yml"),
      "utf8",
    );
    expect(workflow).toContain(`/^project_id = "([^"]+)"/m`);
  });
});
