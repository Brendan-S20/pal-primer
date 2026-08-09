// Text that pushes its row wider instead of truncating, and the correction
// that came out of measuring it.
//
// CLAUDE.md listed this as one of the things a machine could not check: "whether
// text truncates instead of pushing its row wider (a flex child usually needs
// `min-w-0` before `truncate` does anything)". This file checks it, and the
// first thing worth writing down is that the sentence above is half wrong.
//
// ── WHY `truncate` ON THE FLEX ITEM IS NOT THE BUG ────────────────────────
//
// A flex item's `min-width` is `auto`, which resolves to its content's minimum
// width — so an item refuses to shrink below its text, `overflow: hidden` never
// has anything to hide, and the row grows to fit. That is the defect, and it is
// real.
//
// But `auto` has an escape clause: it computes to zero when the item's own
// computed overflow is anything other than `visible`. And `truncate` IS
// `overflow-hidden text-ellipsis whitespace-nowrap`. An element carrying
// `truncate` therefore already satisfies the rule it is supposedly breaking —
// which is the same fact as `overflow-hidden` being an accepted alternative to
// `min-w-0`, said from the other end.
//
// So `<div className="flex"><span className="truncate">` is fine, and adding
// `min-w-0` to that span changes nothing. Three places in this repo do exactly
// that, which is how the belief spreads.
//
// What actually fails is the WRAPPER in between:
//
//     <div className="flex items-center gap-2">
//       <div className="flex-1">              ← overflow visible, min-width auto
//         <p className="truncate">{name}</p>  ← never gets a narrow box to
//       </div>                                   truncate inside
//       <Button>Delete</Button>               ← pushed off the right edge
//     </div>
//
// The wrapper is the flex item, its overflow is visible, and `flex-1` does not
// help: `flex-basis: 0` sets the item's base size, and the automatic minimum
// size then floors it back up at the width of the text. So this checks the
// whole CHAIN from the truncating element up to each flex row it sits in, and
// requires every link in that chain to be allowed to shrink. That is a question
// about JSX nesting, which is why it parses the files rather than matching
// them.
//
// ── WHAT THE MEASUREMENT FOUND ────────────────────────────────────────────
//
// 63 truncating elements across 260 .tsx files, 48 of them inside a flex row,
// and every chain already clean. The idiom is well known here — `min-w-0`
// appears about sixty times in src/, and is right every time it appears, which
// is why nothing in this half needed fixing. This rule ships green, and is worth
// having anyway for the same reason the overload rule in
// scripts/check-dead-machinery.mjs starts green: a rule's first output is
// evidence about the rule, and the next list row someone writes is the one it
// is for.
//
// ── WHAT IT DELIBERATELY DOES NOT CATCH ───────────────────────────────────
//
// `whitespace-nowrap` on its own. Every `<Button>` and every `<TabsTrigger>`
// carries it, deliberately, and none of them truncate — flagging them would
// mean a hundred findings about short labels and a rule nobody reads.
//
// A `flex-col` parent. The main axis there is vertical; a column item is
// stretched to the container's width and cannot be pushed wider by its text.
//
// A grid parent. Tailwind's `grid-cols-N` is `repeat(N, minmax(0, 1fr))`,
// which already floors the track at zero, so the equivalent defect needs a
// hand-written `1fr` track. There are thirteen arbitrary templates in src/ and
// none of them holds truncating text.
//
// An element that is `shrink-0` or `flex-none`. It was told not to shrink; the
// argument to have there is about the layout, not about a missing class.
//
// ── WHAT IT CANNOT SEE, WHICH IS THE PRICE OF THE PRECISION ───────────────
//
// Classes that are not string literals in the file: a `cva` base, a class
// string imported from elsewhere, `[&>span:last-child]:truncate` on
// `SidebarMenuButton`. And flex-ness that lives inside a component — `<Button>`
// is `inline-flex` and this reads `<Button>` as carrying no classes at all.
// Every one of those makes it MISS a violation and none of them make it invent
// one, which is the trade this file wants: the two rules next door were written
// after a check with an 80-false-positive first draft was thrown away, and a
// rule that cries wolf gets deleted rather than obeyed.
//
// ── THE FAMILY THIS FOUND INSTEAD, WHICH IS PINNED AND NOT ENFORCED ───────
//
// Measuring the above turned up the same mechanical fault with a different
// trigger: a value with no break opportunity in it — an email address, a URL, a
// Stripe id, a UUID — sitting in a flex row. Its min-content width is the whole
// token, so the item cannot shrink and the row grows, exactly as above, with no
// `truncate` anywhere for a scanner to notice. Ten of those were fixed across
// six files, and they are pinned by name at the bottom of this file rather than
// turned into a rule, because telling a 40-character signup URL from an
// eight-character promo code means knowing the value, and a rule that guesses
// would flag every `<code>` in the app.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const root = join(import.meta.dirname, "..");

/** Lazy — a read resolved in a `describe` body throws at import time when the
 *  source is stashed, and vitest then reports "no tests" instead of failures,
 *  which is indistinguishable from a pass during a mutation check. */
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** Both comment forms. The fixes below are explained in comments that quote the
 *  markup they replaced — `flex-1`, `truncate`, the class that was missing — so
 *  a `not.toMatch` against raw source would fail on the account of the fix. */
const codeOnly = (src: string) =>
  src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith("//") || t.startsWith("*") || t.startsWith("/*"));
    })
    .join("\n");

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

/** Every class name spelled out as a string literal anywhere inside
 *  `className`, flattened into one list.
 *
 *  Conditional branches are unioned rather than kept apart: `cn(base, open &&
 *  "flex")` counts as flex, and a `min-w-0` that only appears in one branch
 *  counts as present. The first widens what is treated as a flex row and the
 *  second narrows what is treated as a violation, so both settings err the same
 *  way this file errs everywhere — toward saying nothing. */
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

/** `md:min-w-0` and `!truncate` are the same utility as far as this is
 *  concerned. A responsive variant means the rule applies at that width, which
 *  is still a width someone holds the app at. */
const bare = (t: string) => t.replace(/^.*:/, "").replace(/^!/, "");
const has = (cls: string[], name: string) => cls.some((t) => bare(t) === name);

/** A flex container whose main axis is horizontal — the only axis in which an
 *  item can be pushed wider by its text. */
const isFlexRow = (cls: string[]) =>
  (has(cls, "flex") || has(cls, "inline-flex")) &&
  !cls.some((t) => bare(t).startsWith("flex-col")) &&
  !cls.some((t) => bare(t).startsWith("flex-wrap")) &&
  !has(cls, "grid") &&
  !has(cls, "hidden");

/** Text that has been told to cut itself off rather than wrap. `line-clamp-N`
 *  is the same promise in two dimensions and breaks the same way. */
const truncates = (cls: string[]) =>
  has(cls, "truncate") ||
  cls.some((t) => /^line-clamp-[1-9]/.test(bare(t))) ||
  (has(cls, "whitespace-nowrap") && has(cls, "overflow-hidden")) ||
  (has(cls, "whitespace-nowrap") && has(cls, "text-ellipsis"));

/** A flex item allowed to be narrower than its content — either because its
 *  minimum is stated outright, or because its overflow is not `visible` and the
 *  automatic minimum size therefore computes to zero. */
const canShrink = (cls: string[]) =>
  has(cls, "min-w-0") ||
  has(cls, "w-0") ||
  has(cls, "truncate") ||
  cls.some((t) => /^(overflow|overflow-x)-(hidden|auto|scroll|clip)$/.test(bare(t))) ||
  cls.some((t) => /^line-clamp-[1-9]/.test(bare(t))) ||
  cls.some((t) => /^min-w-\[0/.test(bare(t)));

/** Said not to shrink, on purpose. */
const pinnedWide = (cls: string[]) =>
  has(cls, "shrink-0") || has(cls, "flex-none") || has(cls, "flex-shrink-0");

/** How far up from the truncating element to keep looking for flex rows.
 *
 *  Deep enough to cross the row/card/list wrappers a page is built from — the
 *  longest real chain in src/ between truncating text and the flex row that
 *  contains it is four elements — and shallow enough that a page-level
 *  `flex min-h-screen` twelve levels up, whose children are whole columns, does
 *  not start being asked about a caption. */
const CHAIN = 8;

type Trapped = {
  file: string;
  line: number;
  classes: string;
  row: string;
  textAt: number;
};

type Scan = { candidates: number; inAFlexRow: number; trapped: Trapped[] };

function analyse(fileName: string, source: string): Scan {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const parent = new Map<El, El | null>();
  const walk = (n: ts.Node, enclosing: El | null) => {
    let next = enclosing;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      parent.set(n, enclosing);
      next = n;
    }
    ts.forEachChild(n, (c) => walk(c, next));
  };
  walk(sf, null);

  const at = (el: El) => sf.getLineAndCharacterOfPosition(openingOf(el).getStart()).line + 1;
  const scan: Scan = { candidates: 0, inAFlexRow: 0, trapped: [] };

  for (const [el] of parent) {
    if (!truncates(classesOf(el))) continue;
    scan.candidates += 1;

    let item: El = el;
    let above = parent.get(el) ?? null;
    let crossed = false;
    for (let depth = 0; above && depth < CHAIN; depth += 1) {
      const row = classesOf(above);
      const itemClasses = classesOf(item);
      if (isFlexRow(row)) {
        crossed = true;
        if (!canShrink(itemClasses) && !pinnedWide(itemClasses)) {
          scan.trapped.push({
            file: fileName,
            line: at(item),
            classes: itemClasses.join(" "),
            row: row.join(" "),
            textAt: at(el),
          });
        }
      }
      item = above;
      above = parent.get(above) ?? null;
    }
    if (crossed) scan.inAFlexRow += 1;
  }
  return scan;
}

let cached: Scan | null = null;

/** Lazy for the same reason `read` is. */
const wholeApp = (): Scan => {
  if (cached) return cached;
  const total: Scan = { candidates: 0, inAFlexRow: 0, trapped: [] };
  for (const file of tsxFiles(join(root, "src"))) {
    const one = analyse(file.slice(root.length + 1), readFileSync(file, "utf8"));
    total.candidates += one.candidates;
    total.inAFlexRow += one.inAFlexRow;
    total.trapped.push(...one.trapped);
  }
  cached = total;
  return total;
};

describe("truncating text shrinks its box instead of widening its row", () => {
  it("finds the truncating elements, so a green run means checked and not skipped", () => {
    // If this collapses to zero — a rename of `truncate`, a parser that stops
    // reading `cn()`, a walk that never descends — the rule below is vacuously
    // true and stays green through any amount of new markup.
    expect(wholeApp().candidates).toBeGreaterThan(40);
  });

  it("actually walks the ancestry, rather than only reading class lists", () => {
    // The class scan can be perfect and the chain walk still broken, in which
    // case nothing is ever compared against a flex row and the rule is again
    // vacuous. This is the count of candidates that reached one.
    expect(wholeApp().inAFlexRow).toBeGreaterThan(25);
  });

  it("lets every one of them shrink below its text", () => {
    const stranded = wholeApp().trapped.map(
      (t) =>
        `${t.file}:${t.line} — flex item cannot shrink, so the truncate on line ${t.textAt} does nothing` +
        `\n    item: ${t.classes || "(no className)"}` +
        `\n    row:  ${t.row}`,
    );
    // Named rather than counted, and named at the WRAPPER rather than at the
    // text: the class goes on the item, and "1 violation" sends the reader to
    // the truncate, which is the one part that was already right.
    expect(stranded).toEqual([]);
  });
});

describe("the rule is sharp enough to be worth failing on", () => {
  // Positive and negative controls on the predicate itself. Without these, the
  // green run above is evidence about the app only if you already believe the
  // scanner works — and it ships green, so nothing else would ever demonstrate
  // that it can fire.
  const probe = (jsx: string) => analyse("probe.tsx", `export const P = () => (${jsx});`).trapped;

  it("catches the wrapper that swallows a truncate", () => {
    const found = probe(`
      <div className="flex items-center gap-2">
        <div className="flex-1"><p className="truncate">{name}</p></div>
        <button>Delete</button>
      </div>`);
    expect(found).toHaveLength(1);
    expect(found[0].classes).toBe("flex-1");
  });

  it("is quiet once that wrapper can shrink", () => {
    expect(
      probe(`
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1"><p className="truncate">{name}</p></div>
        <button>Delete</button>
      </div>`),
    ).toEqual([]);
  });

  it("leaves a truncate that is itself the flex item alone", () => {
    // The correction in the header, as an assertion. `truncate` carries
    // `overflow-hidden`, the automatic minimum size computes to zero, and the
    // item shrinks. Flagging this would teach people to add a `min-w-0` that
    // does nothing, next to a dozen that do.
    expect(
      probe(`<div className="flex gap-2"><span className="truncate">{name}</span></div>`),
    ).toEqual([]);
  });

  it("does not ask a column or a grid for a horizontal minimum", () => {
    const wrapper = `<div className="flex-1"><p className="truncate">{name}</p></div>`;
    expect(probe(`<div className="flex flex-col gap-2">${wrapper}</div>`)).toEqual([]);
    expect(probe(`<div className="grid grid-cols-3 gap-2">${wrapper}</div>`)).toEqual([]);
  });

  it("takes shrink-0 at its word", () => {
    expect(
      probe(`
      <div className="flex gap-2">
        <div className="shrink-0"><p className="truncate">{name}</p></div>
      </div>`),
    ).toEqual([]);
  });

  it("reads through cn() and template literals, and up through more than one row", () => {
    // Two flex rows, one wrapper each, only the outer one fixed. A walk that
    // stopped at the first row it met would report nothing here.
    const found = probe(`
      <div className="flex items-center">
        <div className={cn("min-w-0", active && "flex items-center gap-1")}>
          <div className={\`flex-1 \${dense ? "text-xs" : ""}\`}>
            <span className="truncate">{name}</span>
          </div>
        </div>
      </div>`);
    expect(found).toHaveLength(1);
    expect(found[0].classes).toContain("flex-1");
  });
});

describe("values with nothing to break at, measured at 360px", () => {
  // The second family, fixed by hand and pinned here. Each of these is one
  // unbreakable token in a flex row: the item's min-content width is the whole
  // token, so the row is at least that wide whatever else is in it.

  it("lets the two public links a tenant is told to share wrap", () => {
    // Three screens hand the owner a link to copy. The referral one has broken
    // its address since it was written; these two are the same panel, built
    // later, without the class — and the slug in them is the business name, so
    // the longer the customer's name the worse it gets.
    expect(codeOnly(read("src/routes/_authenticated/settings.referrals.tsx"))).toMatch(
      /font-mono text-sm break-all/,
    );
    for (const f of [
      "src/routes/_authenticated/settings.lead-form.tsx",
      "src/routes/_authenticated/settings.online-signup.tsx",
    ]) {
      expect(codeOnly(read(f)), f).toMatch(/<code className="break-all rounded bg-muted/);
    }
  });

  it("keeps a 36-character organization id inside the tenant overview card", () => {
    const src = codeOnly(read("src/routes/platform.tenants.$id.tsx"));
    expect(src).toMatch(/<dt className="shrink-0 text-muted-foreground">/);
    expect(src).toMatch(/<dd className="break-all text-right font-medium">/);
    // Same fact spelled out again in the subscription card below it, where the
    // ids are `cus_` and `sub_` rather than a UUID.
    expect(src.match(/className="break-all font-mono text-xs"/g) ?? []).toHaveLength(2);
  });

  it("stops an author's email pushing a control off the right edge", () => {
    // The failure that removes a control rather than merely crowding it: the
    // note row's Delete button and the audit row's date both sat to the right
    // of an address that would not give way.
    const src = codeOnly(read("src/routes/platform.tenants.$id.tsx"));
    expect(src.match(/<div className="flex min-w-0 items-center gap-2">/g) ?? []).toHaveLength(2);
  });

  it("keeps Resend and Revoke on the pending-invite row", () => {
    const src = codeOnly(read("src/routes/_authenticated/settings.users.tsx"));
    expect(src).toMatch(/<span className="min-w-0 break-words">\{i\.email\}/);
    expect(src).toMatch(/<span className="flex shrink-0 items-center gap-3">/);
  });

  it("wraps the invite screen's identity line instead of overflowing it", () => {
    // Four flex items on one line — "as", a role badge, "· for", and a
    // monospace address that is most of a phone's width on its own. This is the
    // first screen a new user ever sees.
    const src = codeOnly(read("src/routes/invite.$token.tsx"));
    expect(src).toMatch(
      /<div className="flex flex-wrap items-center gap-2 text-muted-foreground">/,
    );
    expect(src).toMatch(/<span className="break-all font-mono">\{q\.data\.email\}<\/span>/);
  });

  it("keeps 'Email not sent' visible next to the address it is about", () => {
    const src = codeOnly(read("src/components/ProvisionLocation.tsx"));
    expect(src).toMatch(/<span className="min-w-0 break-words">/);
    expect(src).toMatch(/shrink-0 \$\{i\.emailed \? "text-muted-foreground" : "text-amber-600"\}/);
  });
});
