// #492, the static half, widened from the grooming files to the whole of src/.
//
// A signed-in user cannot SELECT properties.gate_code and the other access
// codes, or accounting_connections' tokens: the table grant was replaced by a
// column grant that leaves them out (tests/support/withheld-columns.ts lists
// them). A select that names one is not filtered, it is REFUSED, and the whole
// request fails with "permission denied for table properties". That is what
// took down My Day, visit detail and the client properties tab on 2026-10-17.
//
// tests/access-codes-are-read-through-one-function.test.ts scans seven
// grooming files for code columns. This scans every file in src/, for every
// withheld column on every narrowed table, and also for `*` on those tables,
// which PostgREST expands to every column and is refused the same way.
//
// A service-role client is not narrowed, so a few call sites may name these
// columns. They are listed below by file with an exact count and a reason, and
// each listed file must import the service-role client. A new call site fails
// until it is either moved to the RPC or added here with its reason. This is
// a ratchet: a listed count that drops fails too, so the list stays true.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { repoRelative } from "./support/repo-paths";
import {
  NARROWED_TABLES,
  selectCalls,
  selectsEveryNarrowedColumn,
  withheldIn,
} from "./support/withheld-columns";

const root = join(import.meta.dirname, "..");

/** Generated column types, not queries. */
const NOT_QUERIES = new Set(["src/integrations/supabase/types.ts"]);

/** Call sites that run on the service role, by file, with how many and why. */
const SERVICE_ROLE_READS: Readonly<Record<string, { count: number; why: string }>> = {
  "src/lib/field-notify.server.ts": {
    count: 1,
    why: "storedGateCode compares the old gate code before an edit; never returned to a browser",
  },
  "src/lib/portal-access.functions.ts": {
    count: 2,
    why: "the client's own portal, after requirePortalSession; there is no signed-in staff user",
  },
  "src/lib/qbo-connection.server.ts": {
    count: 1,
    why: "QuickBooks token refresh; tokens never leave the server",
  },
};

const SERVICE_ROLE_IMPORT = /["']@\/integrations\/supabase\/client\.server["']/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

type Finding = { file: string; line: number; what: string };

function findings(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const call of selectCalls(file, text)) {
    if (call.columns == null) continue;
    for (const column of withheldIn(call.columns)) {
      out.push({ file, line: call.line, what: `asks for ${column}` });
    }
    const everything = selectsEveryNarrowedColumn(call);
    if (everything)
      out.push({ file, line: call.line, what: `selects every column of ${everything}` });
  }
  return out;
}

describe("no signed-in query names a column the grants withhold", () => {
  const all = sourceFiles(join(root, "src"))
    .map((abs) => ({ abs, rel: repoRelative(abs, root) }))
    .filter(({ rel }) => !NOT_QUERIES.has(rel))
    .flatMap(({ abs, rel }) => findings(rel, readFileSync(abs, "utf8")));

  it("finds none outside the listed service-role call sites", () => {
    const stray = all.filter((f) => !(f.file in SERVICE_ROLE_READS));
    expect(
      stray.map((f) => `${f.file}:${f.line} ${f.what}`),
      "a signed-in user is refused the whole request. Read codes through " +
        `${NARROWED_TABLES.properties.readThrough}, or run the read on the service role ` +
        "and list it in SERVICE_ROLE_READS with the reason",
    ).toEqual([]);
  });

  it("finds exactly the listed number at each service-role call site", () => {
    // Counted by call site, not by column: one select naming three codes is one.
    const sites: Record<string, number> = {};
    for (const file of new Set(all.map((f) => f.file))) {
      if (!(file in SERVICE_ROLE_READS)) continue;
      sites[file] = new Set(all.filter((f) => f.file === file).map((f) => f.line)).size;
    }
    const expected = Object.fromEntries(
      Object.entries(SERVICE_ROLE_READS).map(([file, { count }]) => [file, count]),
    );
    expect(sites).toEqual(expected);
  });

  it("only lists files that import the service-role client", () => {
    for (const file of Object.keys(SERVICE_ROLE_READS)) {
      const text = readFileSync(join(root, file), "utf8");
      expect(SERVICE_ROLE_IMPORT.test(text), `${file} does not import client.server`).toBe(true);
    }
  });
});

describe("the scan itself", () => {
  const run = (text: string) => findings("x.ts", text).map((f) => `${f.line} ${f.what}`);

  it("catches the queries that shipped before #492's fix", () => {
    // The My Day embed and the client page list, as production sent them.
    const myDay = `await supabase.from("visits").select(
      "id, properties(label, street, has_units, gate_code, lock_box_code, key_location, parking_notes)",
    );`;
    expect(run(myDay)).toEqual([
      "1 asks for gate_code",
      "1 asks for key_location",
      "1 asks for lock_box_code",
    ]);
    const clientPage = `supabase.from("properties").select("id, label, street, gate_code, yard_size");`;
    expect(run(clientPage)).toEqual(["1 asks for gate_code"]);
  });

  it("catches a key tag, alarm notes and a QuickBooks token", () => {
    expect(run(`db.from("properties").select("id, key_tag, alarm_notes");`)).toEqual([
      "1 asks for alarm_notes",
      "1 asks for key_tag",
    ]);
    expect(run(`db.from("accounting_connections").select("realm_id, refresh_token");`)).toEqual([
      "1 asks for refresh_token",
    ]);
  });

  it("follows a same-file constant and a template", () => {
    const viaConst = `const COLS = "id, street, gate_code";
      db.from("properties").select(COLS);`;
    expect(run(viaConst)).toEqual(["2 asks for gate_code"]);
    const viaTemplate = `const CODES = "lock_box_code";
      db.from("properties").select(\`id, \${CODES}\`);`;
    expect(run(viaTemplate)).toEqual(["2 asks for lock_box_code"]);
  });

  it("catches every column of a narrowed table, directly or embedded", () => {
    expect(run(`db.from("properties").select("*");`)).toEqual([
      "1 selects every column of properties",
    ]);
    expect(run(`db.from("properties").select();`)).toEqual([
      "1 selects every column of properties",
    ]);
    expect(run(`db.from("visits").select("id, properties(*)");`)).toEqual([
      "1 selects every column of properties",
    ]);
    expect(run(`db.from("accounting_connections").select("*")`)).toEqual([
      "1 selects every column of accounting_connections",
    ]);
  });

  it("leaves alone a wildcard on a table that is not narrowed, a code that already arrived, and the RPC", () => {
    const fine = `db.from("visits").select("*");
      db.from("clients").select("*, notes");
      const c = p.gate_code ?? p.key_location;
      await supabase.rpc("property_access_codes", { _property_ids: ids });
      // gate_code comes from the RPC
      db.from("properties").update({ gate_code: "1" }).eq("id", id);`;
    expect(run(fine)).toEqual([]);
  });
});
