// The grooming code added by this PR never reads a gate code, a lock box
// code, a key location or alarm details itself. GroomPetPanel and the
// portal's grooming page with the server code behind it are scanned here.
//
// My Day's visits query (src/lib/my-day.functions.ts) still asks for the
// code columns on main. The walking stack moves that read to
// property_access_codes, and this PR lands after it, so My Day is not
// listed here and this PR does not define its own property_access_codes.
//
// This walks every string in the files below, comments excluded, and names
// file:line for a string that asks for a code column or for every column
// (`*`), which would carry the codes with it. Reading a code that has
// already arrived (`p.gate_code` on a card) is not a query and is not caught.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const root = join(import.meta.dirname, "..");

/** What My Day opens for a groom, and the portal's grooming page with the
 *  server code behind it. */
const ACCESS_CODE_FREE_FILES = [
  "src/components/my-day/GroomPetPanel.tsx",
  "src/routes/portal.$slug.$token.grooming.tsx",
  "src/components/portal/PortalVaccines.tsx",
  "src/lib/portal-groom.functions.ts",
  "src/lib/portal-groom.server.ts",
  "src/lib/groom-request.ts",
  "src/lib/portal.functions.ts",
] as const;

/** properties' code columns, and the spellings a new one would likely take. */
const CODE_COLUMN = /\b(gate_code|lock_box_code|lockbox\w*|lock_box\w*|key_location|alarm\w*)\b/;
/** A select of every column: `*` alone or as an embed, `properties(*)`. */
const EVERY_COLUMN = /(^|[\s,(])\*(\s*[,)]|\s*$)/;

function directCodeReads(file: string, text: string): string[] {
  const src = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    let value: string | null = null;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) value = node.text;
    else if (ts.isTemplateExpression(node))
      value = [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(" ");
    if (value != null) {
      const line = src.getLineAndCharacterOfPosition(node.getStart()).line + 1;
      const code = CODE_COLUMN.exec(value);
      if (code) found.push(`${file}:${line} asks for ${code[1]}`);
      else if (EVERY_COLUMN.test(value) && isSelectArgument(node))
        found.push(`${file}:${line} selects every column`);
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return found;
}

/** Whether a string is the argument of a `.select(...)` call. */
function isSelectArgument(node: ts.Node): boolean {
  const call = node.parent;
  return (
    !!call &&
    ts.isCallExpression(call) &&
    ts.isPropertyAccessExpression(call.expression) &&
    call.expression.name.text === "select"
  );
}

const read = (rel: string) => readFileSync(join(root, rel), "utf8");

describe("the grooming code reads no access codes itself", () => {
  it("no grooming file asks for a code column itself", () => {
    const found = ACCESS_CODE_FREE_FILES.flatMap((f) => directCodeReads(f, read(f)));
    expect(
      found,
      `read access codes through property_access_codes, not in a select:\n${found.join("\n")}`,
    ).toEqual([]);
  });

  it("catches a code column in a select, and a wildcard", () => {
    const shipped = `const q = supabase.from("visits").select(
      "id, properties(label, street, has_units, gate_code, lock_box_code, key_location, parking_notes)",
    );`;
    expect(directCodeReads("my-day.functions.ts", shipped)).toEqual([
      "my-day.functions.ts:2 asks for gate_code",
    ]);
    expect(
      directCodeReads("x.ts", `db.from("visits").select("id, properties(*)");`),
    ).toEqual(["x.ts:1 selects every column"]);
    expect(directCodeReads("x.ts", `db.from("properties").select("*");`)).toEqual([
      "x.ts:1 selects every column",
    ]);
    // A template string is a string too.
    expect(directCodeReads("x.ts", "db.from(t).select(`id, ${cols}, lockbox_code`);")).toEqual([
      "x.ts:1 asks for lockbox_code",
    ]);
  });

  it("does not catch a code that has already arrived, a comment, or the RPC's name", () => {
    const fine = `// gate_code comes from the RPC
      const c = p.gate_code ?? p.key_location;
      await supabase.rpc("property_access_codes", { _property_ids: ids });
      const label = "Gate";`;
    expect(directCodeReads("x.tsx", fine)).toEqual([]);
  });
});
