// A 44px width floor that let a button shrink to 44px.
//
// On the owner's iPhone, 2026-10-04: the "Add card" button on a client's
// billing tab drew its label out through its own right border, and the "Add
// item" button on Inventory was jammed against the screen edge with its label
// clipped. Both are `<Button size="sm">` in a `justify-between` row beside a
// long description, and both rows were fine on a laptop.
//
// The cause is one class, and it is the touch floor. A flex item's
// `min-width` is `auto`, which resolves to "no narrower than my content" —
// that is the only thing that stops a nowrap label being squeezed. `min-w-11`
// does not ADD a 44px minimum to that; it REPLACES it. So the moment
// `touch:min-w-11` applied, every small button in a crowded row was allowed to
// shrink to 44px, and a label that cannot wrap had nowhere to go but out.
// Mouse layouts never saw it, because the variant never applied there.
//
// The fix is `shrink-0` beside the floor. A control whose label does not wrap
// gains nothing by shrinking; the description next to it wraps instead. In
// ui/button.tsx that is `touch:shrink-0` on the two sizes that carry
// `touch:min-w-11` — one edit, 362 small buttons — and this file pins it there.
//
// ── THE REST OF src/ ──────────────────────────────────────────────────────
//
// Hand-rolled controls copied the floor too — the work-day chips, the
// automation day toggles, the visit-size picker on New client. The rule for
// them is the same, and it is about ONE class list, so it is checked on one
// class list: an element whose className sets a width floor of 44px
// (`min-w-11`, `min-w-[2.75rem]` or `min-w-[44px]`, under any variant) and
// that has TEXT among its own children — JSX text, or an `{expression}` that
// might be — must also carry `shrink-0` or `flex-none`, under any variant.
//
// Parsed rather than matched, because "has text among its own children" is a
// question about the tree. Silent, deliberately, on:
//
//   * an element whose only children are elements — an icon button. Its
//     content is a 16px glyph, so a 44px minimum is wider than the content
//     and the automatic minimum would have been smaller anyway.
//   * a self-closing component (`<SidebarTrigger className="min-h-11
//     min-w-11" />`): whatever it renders, it renders as an icon here, and
//     the shrink rule inside it belongs to the component.
//   * classNames that are not literals in the file (an imported constant,
//     a `cva` base). The one `cva` that matters is pinned below by name.
//
// Ratchet from zero: when it landed, five elements in four files carried the
// floor beside text with nothing stopping them shrinking; all were fixed in
// the same change.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { repoRelative } from "./support/repo-paths";

const root = process.cwd();

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return p.endsWith(".tsx") ? [p] : [];
  });
}

const tokensOf = (cls: string) => cls.split(/\s+/).filter(Boolean);
/** The utility a token applies, with any variant prefixes removed. */
const utility = (token: string) => {
  // Variants are separated by `:` outside brackets. `top-[calc(a:b)]` is rare
  // but the bracket guard keeps an arbitrary value intact.
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[") depth++;
    else if (c === "]") depth--;
    else if (c === ":" && depth === 0) last = i;
  }
  return token.slice(last + 1);
};

const WIDTH_FLOOR = /^min-w-(11|\[2\.75rem\]|\[44px\])$/;
const SHRINK_FLOOR = /^(shrink-0|flex-shrink-0|flex-none)$/;

/** Every string a className initializer could contribute: literals, the
 *  static parts of template literals, and string arguments of `cn(...)`. */
function classStrings(init: ts.JsxAttributeValue | undefined): string[] {
  if (!init) return [];
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text);
      for (const span of n.templateSpans) {
        out.push(span.literal.text);
        visit(span.expression);
      }
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(init);
  return out;
}

/** Could this expression render text? An element, a fragment, `null`, or a
 *  choice between those cannot — `{open ? <ChevronDown /> : <ChevronRight />}`
 *  is an icon button, and was the first false positive this rule produced. */
function mayBeText(e: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(e)) return mayBeText(e.expression);
  if (ts.isJsxElement(e) || ts.isJsxSelfClosingElement(e) || ts.isJsxFragment(e)) return false;
  if (e.kind === ts.SyntaxKind.NullKeyword) return false;
  if (ts.isConditionalExpression(e)) return mayBeText(e.whenTrue) || mayBeText(e.whenFalse);
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return mayBeText(e.right);
  }
  return true;
}

function hasTextChild(el: ts.JsxElement): boolean {
  return el.children.some((c) => {
    if (ts.isJsxText(c)) return c.text.trim().length > 0;
    if (ts.isJsxExpression(c)) return c.expression !== undefined && mayBeText(c.expression);
    return false;
  });
}

export function findShrinkableFloors(text: string, filename = "x.tsx"): string[] {
  const src = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && hasTextChild(node)) {
      const attr = node.openingElement.attributes.properties.find(
        (p): p is ts.JsxAttribute =>
          ts.isJsxAttribute(p) && p.name.getText(src) === "className",
      );
      const utilities = classStrings(attr?.initializer).flatMap(tokensOf).map(utility);
      if (utilities.some((u) => WIDTH_FLOOR.test(u)) && !utilities.some((u) => SHRINK_FLOOR.test(u))) {
        const { line } = src.getLineAndCharacterOfPosition(node.getStart(src));
        found.push(`${filename}:${line + 1}  <${node.openingElement.tagName.getText(src)}>`);
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return found;
}

describe("a width floor is not a shrink floor", () => {
  it("ui/button.tsx puts the shrink floor beside every touch width floor", () => {
    const src = readFileSync(join(root, "src/components/ui/button.tsx"), "utf8");
    const block = src.slice(src.indexOf("size: {"), src.indexOf("defaultVariants"));
    const lines = block.split("\n").filter((l) => /^\s*(default|sm|lg|icon):/.test(l));
    expect(lines.length, "the size block parse has drifted").toBe(4);
    for (const line of lines.filter((l) => /min-w-11/.test(l))) {
      expect(
        line,
        "a button size sets touch:min-w-11 without touch:shrink-0 — beside a long description it " +
          "shrinks to 44px and its label runs out through its border",
      ).toMatch(/touch:shrink-0/);
    }
  });

  it("no element in src/ sets a 44px width floor beside text and lets it shrink", () => {
    const offenders = walk(join(root, "src")).flatMap((f) =>
      findShrinkableFloors(readFileSync(f, "utf8"), repoRelative(f, root)),
    );
    expect(offenders, "add shrink-0 beside the min-w floor").toEqual([]);
  });

  // The rule, proved on the shapes it is about rather than trusted.
  it("catches the shape that shipped and passes its fix", () => {
    const broke = `<div className="flex"><p>long</p><button className="px-3 touch:min-h-11 touch:min-w-11">Add card</button></div>`;
    const fixed = `<div className="flex"><p>long</p><button className="px-3 touch:min-h-11 touch:min-w-11 shrink-0">Add card</button></div>`;
    const template = "<button className={`px-2 touch:min-w-11 ${on ? 'a' : 'b'}`}>{d}</button>";
    expect(findShrinkableFloors(broke)).toHaveLength(1);
    expect(findShrinkableFloors(fixed)).toEqual([]);
    expect(findShrinkableFloors(template)).toHaveLength(1);
  });

  it("is silent on icon buttons and self-closing components", () => {
    const icon = `<button className="p-1 touch:min-h-11 touch:min-w-11"><X className="h-4 w-4 shrink-0" /><span className="sr-only">Close</span></button>`;
    const selfClosing = `<SidebarTrigger className="min-h-11 min-w-11" />`;
    const eitherIcon = `<button className="touch:min-w-11">{open ? <ChevronDown /> : <ChevronRight />}</button>`;
    expect(findShrinkableFloors(icon)).toEqual([]);
    expect(findShrinkableFloors(eitherIcon)).toEqual([]);
    expect(findShrinkableFloors(selfClosing)).toEqual([]);
  });
});
