// A signed-in page is laid out in PageShell's column, and does not draw one
// of its own.
//
// ── THE BUG ───────────────────────────────────────────────────────────────
//
// The owner, 2026-10-02: "The page widths should be identically the same
// when viewing it on the same size screen." They were not. The layout gave
// every page one padded 1600px column, and then the page's own root element
// drew another inside it:
//
//     <div className="mx-auto max-w-2xl space-y-6">     clients/new, my-schedule, profile
//     <div className="mx-auto max-w-3xl space-y-5">     quotes/new, quotes/:id
//     <div className="mx-auto max-w-4xl space-y-6">     onboarding, review, settings/addons
//     <div className="max-w-2xl space-y-6">             eight settings sections
//     <div className="max-w-5xl space-y-6">             payments
//     <div className={`-mx-4 -my-6 ...`}>               my-day
//
// Measured at 1920px the page heading sat at eight different x positions.
//
// `src/components/PageShell.tsx` is now the one place the column is decided,
// and `tests/viewports/every-page-has-the-same-margins.spec.ts` measures every
// page in a browser. This is the half that names the FILE AND LINE, in a
// second, with no server — the same division of labour CLAUDE.md describes
// for every other rule here.
//
// ── WHAT COUNTS ───────────────────────────────────────────────────────────
//
// The ROOT element of anything a route's `component` returns, under
// `src/routes/_authenticated/`. A root that carries `mx-auto`, `container`, a
// `max-w-*` (other than `max-w-full` / `max-w-none`), padding that reaches
// the sides (`p-4`, `px-6`), or a horizontal margin is a column of its own.
// Padding on a CARD is not — a root with a border or a background is a box
// you can see, and its content is inset from an edge the eye reads. Padding
// on nothing at all is an invisible gutter, and that is the fault: the
// scheduling page's error and loading lines sat 16px in from every other
// page's first line, and franchise's not-a-franchise state 24px.
//
// Deliberately NOT flagged: anything below the root. A form whose fields stop
// at a readable width, a paragraph held to `max-w-2xl`, a dialog's
// `sm:max-w-lg` — those are layout inside a section, not a different page
// width. It parses rather than greps for the same reason the fragment test
// does: the question is about position, and `max-w-2xl` on a paragraph is
// spelled exactly like `max-w-2xl` on a page.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");
const routesDir = join(root, "src/routes/_authenticated");

const COLUMN_CLASS =
  /(^|\s)(mx-auto|container|-?m[xlr]?-\S+|(?:\w+:)*max-w-(?!full\b|none\b)\S+)(?=\s|$)/;
const SIDE_PADDING = /(^|\s)((?:\w+:)*p[xlr]?-\S+)(?=\s|$)/;
const A_CARD = /(^|\s)(border|bg-\S+)(?=\s|$)/;

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

/** The text of a className attribute, as far as it is written literally. */
function classText(el: ts.JsxOpeningLikeElement): string | null {
  for (const prop of el.attributes.properties) {
    if (!ts.isJsxAttribute(prop) || prop.name.getText() !== "className" || !prop.initializer)
      continue;
    const init = prop.initializer;
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) {
      const e = init.expression;
      if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
      if (ts.isTemplateExpression(e)) {
        return [e.head.text, ...e.templateSpans.map((s) => s.literal.text)].join(" ");
      }
    }
  }
  return null;
}

/** Each `return` of a function body, skipping nested functions. */
function returnedExpressions(body: ts.Node): ts.Node[] {
  if (!ts.isBlock(body)) return [unwrap(body)];
  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isArrowFunction(node) ||
      ts.isFunctionExpression(node) ||
      ts.isFunctionDeclaration(node)
    ) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) found.push(unwrap(node.expression));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(body, visit);
  return found;
}

export function findOwnColumns(text: string, filename = "x.tsx"): string[] {
  const src = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  // `createFileRoute("…")({ component: Name })` — the page.
  const components = new Set<string>();
  const findRoute = (node: ts.Node) => {
    if (ts.isObjectLiteralExpression(node) && ts.isCallExpression(node.parent)) {
      const callee = node.parent.expression;
      if (ts.isCallExpression(callee) && callee.expression.getText() === "createFileRoute") {
        for (const p of node.properties) {
          if (ts.isPropertyAssignment(p) && p.name.getText() === "component") {
            if (ts.isIdentifier(p.initializer)) components.add(p.initializer.text);
          }
        }
      }
    }
    ts.forEachChild(node, findRoute);
  };
  findRoute(src);

  const bodies: ts.Node[] = [];
  for (const st of src.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && components.has(st.name.text) && st.body) {
      bodies.push(st.body);
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          components.has(d.name.text) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          bodies.push(d.initializer.body);
        }
      }
    }
  }

  const found: string[] = [];
  for (const body of bodies) {
    for (const r of returnedExpressions(body)) {
      const opening = ts.isJsxElement(r)
        ? r.openingElement
        : ts.isJsxSelfClosingElement(r)
          ? r
          : null;
      if (!opening) continue;
      const cls = classText(opening);
      const m =
        cls && (COLUMN_CLASS.exec(cls) ?? (A_CARD.test(cls) ? null : SIDE_PADDING.exec(cls)));
      if (m) {
        const { line } = src.getLineAndCharacterOfPosition(opening.getStart(src));
        found.push(`${filename}:${line + 1}  ${m[2]}`);
      }
    }
  }
  return found;
}

function violations(): string[] {
  const out: string[] = [];
  for (const f of readdirSync(routesDir)) {
    if (!f.endsWith(".tsx") || f === "route.tsx") continue;
    const file = join(routesDir, f);
    for (const hit of findOwnColumns(readFileSync(file, "utf8"), repoRelative(file, root))) {
      out.push(
        `${hit}  the page's root draws a column of its own\n` +
          `      Width, horizontal padding and centring belong to PageShell ` +
          `(src/components/PageShell.tsx), which the layout already wraps around ` +
          `this page. Drop the class; if the page genuinely needs every pixel, ` +
          `declare \`staticData: { pageWidth: "wide" }\` on its route instead.`,
      );
    }
  }
  return out;
}

describe("a signed-in page does not draw a column of its own", () => {
  it("finds no route component whose root sets its own width or gutter", () => {
    expect(violations().join("\n")).toBe("");
  });

  it("reads the route files at all, so a green run means checked", () => {
    const files = readdirSync(routesDir).filter((f) => f.endsWith(".tsx"));
    expect(files.length).toBeGreaterThanOrEqual(60);
    expect(files).toContain("settings.sms.tsx");
  });

  it("would have caught the wrappers that shipped", () => {
    // The real roots, as they were on 2026-10-02.
    for (const root of [
      `<div className="mx-auto max-w-2xl space-y-6">`,
      `<div className="max-w-2xl space-y-6">`,
      `<div className="p-6">`,
      `<div className="mx-auto max-w-6xl space-y-6 overflow-x-hidden max-w-full">`,
      '<div className={`-mx-4 -my-6 ${view === "map" ? "pb-0" : pad}`}>',
    ]) {
      const page = `
        export const Route = createFileRoute("/_authenticated/x")({ component: Page });
        function Page() {
          if (loading) return <p>Loading</p>;
          return (
            ${root}
              <h1>Title</h1>
            </div>
          );
        }`;
      expect(findOwnColumns(page), root).toHaveLength(1);
      // And the fix passes.
      const fixed = page.replace(root, "<>").replace("</div>", "</>");
      expect(findOwnColumns(fixed), root).toEqual([]);
    }
  });

  it("leaves narrow content INSIDE a section alone", () => {
    const page = `
      export const Route = createFileRoute("/_authenticated/x")({ component: Page });
      const Page = () => (
        <div className="space-y-6">
          <p className="max-w-2xl text-sm">A paragraph held to a measure.</p>
          <form className="mx-auto max-w-md px-4" />
        </div>
      );`;
    expect(findOwnColumns(page)).toEqual([]);
    // And a card's own padding is the card's.
    const card = page.replace(
      '<div className="space-y-6">',
      '<div className="rounded-lg border bg-card p-6">',
    );
    expect(findOwnColumns(card)).toEqual([]);
  });
});
