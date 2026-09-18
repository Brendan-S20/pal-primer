// A `.map()` that returns a bare `<>` has no key, and the keys inside it are
// inert.
//
// ── THE BUG, WHICH LOOKED LIKE IT HAD ALREADY BEEN FIXED ──────────────────
//
// `src/routes/_authenticated/settings.users.tsx` mapped the user list to a
// fragment holding two rows — the person, and the expandable routing panel
// beneath them:
//
//     {(data?.users ?? []).map((u: any) => {
//       ...
//       return (
//         <>
//           <tr key={u.user_id}>…</tr>
//           {isOpen && <tr key={u.user_id + "-addr"}>…</tr>}
//         </>
//       );
//     })}
//
// Both rows carry a key. Neither does anything. React keys the DIRECT CHILD
// of the array, and that is the fragment; the two `<tr>`s inside it are
// static siblings in a fixed position, not a list, so their keys are read by
// nothing. `<>` takes no props at all, so the shorthand is the bug rather
// than an unlucky spelling — the fix is `<Fragment key={…}>`.
//
// This is why it survived review. The file does not look like it forgot
// about keys. It looks like it thought about them twice.
//
// ── WHY IT IS NOT JUST A CONSOLE WARNING ──────────────────────────────────
//
// Without a key the table reconciles by INDEX, and every row on that page
// owns state React attaches positionally: `expanded` keyed on staff_id, a
// `<Select>` per row for the role, and a Deactivate button whose label reads
// from `u.active`. Deactivating somebody refetches, the list re-sorts, and
// the open panel and the role dropdown stay at their old offsets — now
// belonging to whoever moved into that position.
//
// ── AND WHY A TEST RATHER THAN A NOTE ─────────────────────────────────────
//
// React does report this, loudly, at runtime. It reported it throughout the
// APPLE_SIZES sweep on 2026-09-17, in the dev-server log, while 402
// assertions passed: the sweep measures geometry and does not read the
// console. So the information existed, in the output, on the day — and
// nothing was going to act on it. That is the same shape as the two
// comments described in `a-thumb-is-not-a-screen-width.test.ts`, which named
// the correct fix and then argued themselves out of it.
//
// ── WHAT COUNTS AS A VIOLATION ────────────────────────────────────────────
//
// Only a JSX FRAGMENT (`<>…</>`) in the RETURN POSITION of a `.map()`
// callback. That is a property about nesting, not a string, so this parses
// rather than greps — a regex for `<>` finds component returns too, and a
// scan written that way flagged three sites of which two were exactly that.
//
// Deliberately NOT flagged:
//
//   * `<Fragment key={…}>` — the fix, and `<React.Fragment key={…}>`.
//   * A component's own `return (<>…</>)`. Not an array child; no key
//     applies or is possible.
//   * `<>` anywhere else in a callback — a variable, a prop like
//     `description={<>…</>}`, a nested helper's return.
//   * `.map()` over non-JSX. It simply never reaches a fragment.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function unwrap(node: ts.Node): ts.Node {
  let n = node;
  while (ts.isParenthesizedExpression(n)) n = n.expression;
  return n;
}

/**
 * Every expression a callback can hand back: the body of a concise arrow, or
 * each `return` in a block body. Nested functions are skipped — their returns
 * belong to them, not to the map.
 */
function returnedExpressions(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Node[] {
  if (!ts.isBlock(fn.body)) return [unwrap(fn.body)];

  const found: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
      return;
    }
    if (ts.isReturnStatement(node) && node.expression) found.push(unwrap(node.expression));
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return found;
}

/** `xs.map(...)` — the callee is a property access whose name is `map`. */
function isMapCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "map"
  );
}

export function findKeylessFragments(text: string, filename = "x.tsx"): string[] {
  const src = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];

  const visit = (node: ts.Node) => {
    if (isMapCall(node)) {
      const cb = node.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb))) {
        for (const returned of returnedExpressions(cb)) {
          if (returned.kind === ts.SyntaxKind.JsxFragment) {
            const { line } = src.getLineAndCharacterOfPosition(returned.getStart(src));
            found.push(`${filename}:${line + 1}`);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(src, visit);
  return found;
}

function violations(): string[] {
  const out: string[] = [];
  for (const file of sourceFiles(join(root, "src"))) {
    for (const hit of findKeylessFragments(readFileSync(file, "utf8"), repoRelative(file, root))) {
      out.push(
        `${hit}  a .map() returns <>, which cannot take a key\n` +
          `      React keys the direct child of the array, and that is this fragment. Any ` +
          `key on an element INSIDE it is inert. Use \`<Fragment key={…}>\` — import ` +
          `\`Fragment\` from "react". Without it the list reconciles by index, so per-row ` +
          `state (an open panel, a <Select>, a label read from the row) stays at its old ` +
          `offset when the list re-sorts and belongs to the wrong row.`,
      );
    }
  }
  return out;
}

describe("a mapped fragment carries the key, because the elements inside it cannot", () => {
  it("finds no .map() returning a bare fragment", () => {
    expect(violations().join("\n")).toBe("");
  });

  it("would have caught the one that shipped, so a green run means checked", () => {
    // The shape from settings.users.tsx, keys and all. Without this the test
    // above proves only that the walker ran.
    const shipped = `
      export function UsersPage({ data }: any) {
        return (
          <tbody>
            {(data?.users ?? []).map((u: any) => {
              const isOpen = expanded.has(u.staff_id);
              return (
                <>
                  <tr key={u.user_id}><td>{u.email}</td></tr>
                  {isOpen && <tr key={u.user_id + "-addr"}><td>addr</td></tr>}
                </>
              );
            })}
          </tbody>
        );
      }`;
    expect(findKeylessFragments(shipped)).toHaveLength(1);

    // And the fix must pass, or the rule is unsatisfiable.
    const fixed = shipped
      .replace("<>", "<Fragment key={u.user_id}>")
      .replace("</>", "</Fragment>");
    expect(findKeylessFragments(fixed)).toEqual([]);
  });

  it("catches a concise arrow too, not only a block body", () => {
    const concise = `const X = () => <ul>{rows.map((r) => (<><li>{r.a}</li><li>{r.b}</li></>))}</ul>;`;
    expect(findKeylessFragments(concise)).toHaveLength(1);
  });

  it("leaves component returns and non-array fragments alone", () => {
    // Every one of these is a legitimate `<>` that a text scan flags and this
    // rule must not. The first two are the real sites a regex-based version of
    // this check reported before it was rewritten to parse.
    for (const ok of [
      // A component's own return, above an unrelated .map() in the same file.
      `function Rows({ rows }: any) {
         const addresses = new Set(rows.map((r: any) => r.street));
         return (<><p>{addresses.size}</p></>);
       }`,
      // A fragment passed as a prop, in a function that also maps.
      `async function ask(rows: any) {
         const members = rows.map((r: any) => r.email);
         return confirm({ description: (<><p>Send to {members.length}?</p></>) });
       }`,
      // The fix.
      `<ul>{rows.map((r) => (<Fragment key={r.id}><li>{r.a}</li></Fragment>))}</ul>`,
      // A keyed element, which is the ordinary case and by far the commonest.
      `<ul>{rows.map((r) => (<li key={r.id}>{r.a}</li>))}</ul>`,
      // A nested helper's fragment return does not belong to the map.
      `<ul>{rows.map((r) => {
         const label = () => (<><b>{r.a}</b></>);
         return (<li key={r.id}>{label()}</li>);
       })}</ul>`,
      // .map() over data, nowhere near JSX.
      `const ids = rows.map((r) => r.id);`,
    ]) {
      expect(findKeylessFragments(ok), `should not be flagged:\n${ok}`).toEqual([]);
    }
  });
});
