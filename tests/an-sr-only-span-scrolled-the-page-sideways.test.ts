/**
 * A 1x1 span nobody can see, setting the width of the page.
 *
 * ── THE BUG ───────────────────────────────────────────────────────────────
 *
 * Found by driving /clients/:id as owner at 768px and reading geometry: the
 * page scrolled sideways by 76px. Nothing visible was over-wide. The Billing
 * tab's invoice table is 559px inside a `overflow-x-auto` wrapper, which is
 * exactly the arrangement the repo already requires, and the wrapper's own
 * right edge was comfortably inside the viewport.
 *
 * The culprit was `<span className="sr-only">Actions</span>`, the accessible
 * name of the last column. `sr-only` is `position: absolute`, and CSS is
 * explicit that **overflow clipping does not apply to a descendant whose
 * containing block lies outside the clipping box**. The wrapper was `position:
 * static`, so it was not the span's containing block; the initial containing
 * block was. The span therefore resolved against the document, landed at
 * x=843 on a 768px viewport, and widened <html> — while `body.scrollWidth`
 * stayed 768, which is why a body-only measurement sees nothing.
 *
 * This is the second time. docs/mobile-ux-audit.md 6.10 records the first:
 * the same class on the same element scrolled /clients 663px. That one was
 * fixed in place. Nothing stopped the next one, and there were two.
 *
 * ── WHY THE EXISTING TESTS COULD NOT SEE IT ───────────────────────────────
 *
 * `wide-things-that-set-the-width-of-the-page.test.ts` asks whether a wide
 * table has a scroll container. It does — that test was correctly green. The
 * question here is whether the container is a containing block, which is a
 * different property of the same element and invisible to a rule about
 * `overflow-x-auto`.
 *
 * `a-flex-row-as-wide-as-its-longest-word.test.ts` traces flex rows. An
 * absolutely positioned element is not in the flow of any of them.
 *
 * And the browser sweeps could not have caught it either: neither
 * `every-signed-in-page-at-every-width.spec.ts` nor anything else clicks
 * through to the Billing tab, so the markup was never rendered under
 * measurement. The viewport spec added alongside this file does.
 *
 * ── WHAT THIS ASSERTS ─────────────────────────────────────────────────────
 *
 * Parsed, not matched, because the question is about nesting: is there an
 * `sr-only` anywhere inside a scroll container that is not itself positioned.
 * A regex over class lists cannot answer that — the two classes are on
 * different elements and any number of lines apart.
 *
 * Deliberately narrow. It says nothing about an `sr-only` outside a scroller
 * (harmless — nothing is clipping it), nothing about a scroller with no
 * `sr-only` in it (nothing to escape), and nothing about `absolute` written
 * out longhand, which is rare enough in this repo to be a deliberate act.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dirname, "..");

/** Lazy. A read resolved in a `describe` body throws at import time when the
 *  source is stashed, and vitest reports "no tests" rather than failures —
 *  which is indistinguishable from a pass during a mutation check. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsxFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

type El = ts.JsxElement | ts.JsxSelfClosingElement;
const openingOf = (el: El) => (ts.isJsxElement(el) ? el.openingElement : el);

/** Every class name spelled as a string literal anywhere inside `className`,
 *  flattened. Conditional branches are unioned: `cn(base, x && "relative")`
 *  counts as relative. That widens what counts as fixed and so errs toward
 *  saying nothing, which is how the other structural tests here are set. */
function classesOf(el: El): string[] {
  const parts: string[] = [];
  const collect = (n: ts.Node | undefined) => {
    if (!n) return;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      parts.push(n.text);
      return;
    }
    if (ts.isTemplateExpression(n)) {
      parts.push(n.head.text);
      for (const span of n.templateSpans) {
        parts.push(span.literal.text);
        collect(span.expression);
      }
      return;
    }
    ts.forEachChild(n, collect);
  };
  for (const attr of openingOf(el).attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText() !== "className") continue;
    if (attr.initializer && ts.isStringLiteral(attr.initializer)) parts.push(attr.initializer.text);
    else if (attr.initializer && ts.isJsxExpression(attr.initializer))
      collect(attr.initializer.expression);
  }
  return parts.join(" ").split(/\s+/).filter(Boolean);
}

/** `max-md:overflow-x-auto` clips at that width, and that width is one
 *  somebody holds the app at. A variant does not make the rule not apply. */
const bare = (t: string) => t.replace(/^.*:/, "").replace(/^!/, "");
const has = (cls: string[], name: string) => cls.some((t) => bare(t) === name);

/** Any non-static position makes the element a containing block for an
 *  absolutely positioned descendant, which is the whole of what is needed. */
const POSITIONED = ["relative", "absolute", "fixed", "sticky"];

type Escape = { file: string; line: number; container: string };

/** Every scroll container that clips, is not a containing block, and has an
 *  `sr-only` somewhere below it. */
function escapees(): { scrollers: number; withSrOnly: number; bad: Escape[] } {
  let scrollers = 0;
  let withSrOnly = 0;
  const bad: Escape[] = [];
  for (const file of tsxFiles(join(root, "src"))) {
    const src = readFileSync(file, "utf8");
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (n: ts.Node) => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const cls = classesOf(n as El);
        if (has(cls, "overflow-x-auto")) {
          scrollers++;
          let found = false;
          const sub = (m: ts.Node) => {
            if (m !== n && (ts.isJsxElement(m) || ts.isJsxSelfClosingElement(m))) {
              if (has(classesOf(m as El), "sr-only")) found = true;
            }
            ts.forEachChild(m, sub);
          };
          ts.forEachChild(n, sub);
          if (found) {
            withSrOnly++;
            if (!POSITIONED.some((p) => has(cls, p))) {
              bad.push({
                file: file.slice(root.length + 1),
                line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1,
                container: cls.join(" "),
              });
            }
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(sf);
  }
  return { scrollers, withSrOnly, bad };
}

describe("an absolutely positioned child cannot be clipped by a static parent", () => {
  it("finds the scrollers at all, so a green run means checked and not skipped", () => {
    const { scrollers, withSrOnly } = escapees();
    // If the parser stops seeing className — a Tailwind rename, a cn() helper
    // that hides the literals — every count goes to zero and the rule below
    // passes by finding nothing. These two numbers are the tripwire.
    expect(scrollers).toBeGreaterThan(20);
    expect(withSrOnly).toBeGreaterThan(0);
  });

  it("gives every scroller containing an sr-only a containing block", () => {
    const { bad } = escapees();
    expect(
      bad.map(
        (b) => `${b.file}:${b.line} — [${b.container}] clips, but an sr-only inside it escapes`,
      ),
    ).toEqual([]);
  });

  it("names the two that shipped, so the fix cannot be quietly reverted", () => {
    // The invoice table on the client Billing tab: 76px of sideways page
    // scroll at 768px, from the Actions column header.
    expect(read("src/components/client-detail/billing-panels.tsx")).toMatch(
      /relative mt-3 overflow-x-auto/,
    );
    // The platform plans table, same shape, found by the scan above rather
    // than by anyone reporting it.
    expect(read("src/routes/platform.plans.tsx")).toMatch(/relative overflow-x-auto/);
  });
});

describe("the way out of an empty state is a target a thumb can hit", () => {
  it("sizes the boundary-editor link on the Properties tab", () => {
    const src = read("src/components/client-detail/PropertiesTab.tsx");
    const btn = src.slice(
      Math.max(0, src.indexOf("Draw it in the editor") - 400),
      src.indexOf("Draw it in the editor"),
    );
    // It was `mt-2 text-primary hover:underline` — a 20px line of text, and
    // the only control in the "No boundary drawn yet" state.
    expect(btn).toMatch(/touch:min-h-11/);
    // A min-height on an inline element does nothing; it needs a box.
    expect(btn).toMatch(/inline-flex/);
  });

  it("uses the pointer variant, not a width guess", () => {
    // Every iPad is 744px or wider and all of it is touch, so `max-md:` is
    // off on exactly the device that needs the floor most. See src/styles.css.
    const src = read("src/components/client-detail/PropertiesTab.tsx");
    const btn = src.slice(
      Math.max(0, src.indexOf("Draw it in the editor") - 400),
      src.indexOf("Draw it in the editor"),
    );
    expect(btn).not.toMatch(/max-md:min-h-11/);
  });
});
