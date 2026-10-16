// A button inside a <form> says what it does: type="button" or type="submit".
//
// ── THE BUG ───────────────────────────────────────────────────────────────
//
// The zone drawer is a <form> (src/components/ZoneDrawer.tsx), and its map
// coverage toolbar lives in another file, src/components/ZoneCoverageMap.tsx.
// The Polygon, Radius and Drive time buttons there, and Undo and Clear, had
// no `type`. A <button> with no type inside a form is a SUBMIT button, so a
// tap on "Polygon" saved the zone and closed the drawer (#448). On New zone
// that created a zone with whatever coverage happened to be there; one demo
// zone exists because of it.
//
// Nothing about the file looked wrong. Each button had an onClick that did
// exactly what its label says. The default only shows up when the component
// is rendered inside a form, and the form is in a different file.
//
// ── WHY NOT CHANGE THE DEFAULT IN ui/button.tsx ───────────────────────────
//
// It would fix this class in one line, and it would also turn any <Button>
// that submits by default (inside a form, with no type) into a button that
// does nothing. This scan found none written lexically inside a form, but it
// cannot see every form a shared component ends up in, so the safe change is
// the local one plus this rule.
//
// ── WHAT IS CHECKED ───────────────────────────────────────────────────────
//
// For every JSX <form> in src/:
//   * every <Button> or <button> inside it declares `type` (or is `asChild`,
//     which renders something else);
//   * every component rendered inside it that is declared at the top of the
//     same file, or imported from a .tsx file in src/ outside components/ui/,
//     has a `type` on every <Button> and <button> it contains. For an imported
//     component the whole file is held to it: a component file is small, and
//     the one component a form uses today is not the only one it will use.
//
// Deliberately silent on components/ui/ (Radix sets type="button" on what it
// renders) and on anything more than one component deep.

import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

import ts from "typescript";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");
const src = join(root, "src");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const parse = (file: string, text = readFileSync(file, "utf8")) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function openingOf(node: ts.Node) {
  if (ts.isJsxElement(node)) return node.openingElement;
  if (ts.isJsxSelfClosingElement(node)) return node;
  return null;
}

/** Every <Button>/<button> under `node` with no `type` and no `asChild`. */
function untypedButtons(node: ts.Node, sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    const o = openingOf(n);
    if (o) {
      const tag = o.tagName.getText(sf);
      if (tag === "Button" || tag === "button") {
        const named = o.attributes.properties.some(
          (a) => ts.isJsxAttribute(a) && ["type", "asChild"].includes(a.name.getText(sf)),
        );
        if (!named) {
          const line = sf.getLineAndCharacterOfPosition(o.getStart()).line + 1;
          out.push(`${repoRelative(sf.fileName, root)}:${line}`);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/**
 * Untyped buttons that would render inside a form in `file`. `read` lets a
 * test hand in source text for a file instead of reading it from disk.
 */
export function buttonsThatWouldSubmit(
  file: string,
  read: (f: string) => string | null = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null),
): { faults: string[]; reached: string[] } {
  const text = read(file);
  if (text == null) return { faults: [], reached: [] };
  const sf = parse(file, text);
  const imports = new Map<string, string>();
  const locals = new Map<string, ts.Node>();
  for (const s of sf.statements) {
    if (ts.isImportDeclaration(s) && s.importClause && ts.isStringLiteral(s.moduleSpecifier)) {
      const spec = s.moduleSpecifier.text;
      if (s.importClause.name) imports.set(s.importClause.name.text, spec);
      const nb = s.importClause.namedBindings;
      if (nb && ts.isNamedImports(nb)) for (const e of nb.elements) imports.set(e.name.text, spec);
    } else if (ts.isFunctionDeclaration(s) && s.name) {
      locals.set(s.name.text, s);
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) locals.set(d.name.text, d);
      }
    }
  }
  const resolve = (spec: string): string | null => {
    let base: string;
    if (spec.startsWith("@/")) base = join(src, spec.slice(2));
    else if (spec.startsWith(".")) base = join(dirname(file), spec);
    else return null;
    if (repoRelative(base, root).startsWith("src/components/ui/")) return null;
    for (const ext of [".tsx", "/index.tsx"]) if (read(base + ext) != null) return base + ext;
    return null;
  };

  const faults = new Set<string>();
  const reached = new Set<string>();
  const insideForm = (n: ts.Node) => {
    const o = openingOf(n);
    if (o) {
      const tag = o.tagName.getText(sf);
      if (/^[A-Z]/.test(tag) && tag !== "Button") {
        const local = locals.get(tag);
        const spec = imports.get(tag);
        if (local) {
          for (const f of untypedButtons(local, sf)) faults.add(f);
        } else if (spec) {
          const target = resolve(spec);
          const body = target ? read(target) : null;
          if (target && body != null) {
            reached.add(repoRelative(target, root));
            for (const f of untypedButtons(parse(target, body), parse(target, body))) faults.add(f);
          }
        }
      }
    }
    ts.forEachChild(n, insideForm);
  };
  const findForms = (n: ts.Node) => {
    const o = openingOf(n);
    if (o && o.tagName.getText(sf) === "form") {
      for (const f of untypedButtons(n, sf)) faults.add(f);
      insideForm(n);
      return;
    }
    ts.forEachChild(n, findForms);
  };
  findForms(sf);
  return { faults: [...faults], reached: [...reached] };
}

describe("a button inside a form says what it does", () => {
  it("every button a <form> renders, in its own file or one component down, has a type", () => {
    const faults = new Set<string>();
    for (const file of sourceFiles(src)) {
      for (const f of buttonsThatWouldSubmit(file).faults) faults.add(f);
    }
    expect(
      [...faults].sort(),
      "these buttons have no `type` and render inside a <form>, so a click submits it. " +
        'Add type="button", or type="submit" if submitting is what it is for.',
    ).toEqual([]);
  });

  it("reaches the zone drawer's map toolbar, which is where #448 was", () => {
    const { reached } = buttonsThatWouldSubmit(join(src, "components/ZoneDrawer.tsx"));
    expect(reached).toContain("src/components/ZoneCoverageMap.tsx");
  });

  it("fails the toolbar as it shipped before the fix", () => {
    // The pre-fix mode buttons, reduced to what the rule reads.
    const files: Record<string, string> = {
      [join(src, "components/Drawer.tsx")]: `
        import { Toolbar } from "@/components/Toolbar";
        export function Drawer() {
          return <form><Toolbar /><Button type="submit">Save</Button></form>;
        }`,
      [join(src, "components/Toolbar.tsx")]: `
        export function Toolbar() {
          return (
            <div>
              <Button size="sm" onClick={() => {}}>Polygon</Button>
              <Button type="button" size="sm" onClick={() => {}}>Radius</Button>
            </div>
          );
        }`,
    };
    const { faults } = buttonsThatWouldSubmit(
      join(src, "components/Drawer.tsx"),
      (f) => files[f] ?? null,
    );
    expect(faults).toEqual(["src/components/Toolbar.tsx:5"]);
  });

  it("is silent on a button outside any form", () => {
    const file = join(src, "components/Loose.tsx");
    const { faults } = buttonsThatWouldSubmit(file, (f) =>
      f === file ? `export function Loose() { return <div><Button>Go</Button></div>; }` : null,
    );
    expect(faults).toEqual([]);
  });
});
