// A control a screen reader announces as "button" and nothing else.
//
// ── WHERE THIS CAME FROM ───────────────────────────────────────────────────
//
// The round-2 audit ran axe-core over 159 signed-in screens and found 496
// serious or critical nodes on 123 of them (gaps-r2-11, extending F-29). Most
// were not 496 faults. They were a handful of SHARED pieces drawn on every
// page: the setup banner's grey "Next: …" line, the ⌘K hint in the top bar,
// the tab bar's labels, and the Radix Select trigger, which is a
// `<button role="combobox">` and so takes no name from the value it shows. A
// combobox is not named by its contents in ARIA, so "All statuses" on the
// face of the Clients filter is something a sighted person reads and a
// screen reader does not: axe reports it as button-name, critical.
//
// This file pins the fixes that a parser can see. The rendered half, axe
// itself over the shared pieces in jsdom, is
// `axe-finds-nothing-serious-in-the-shared-pieces.test.tsx`. jsdom has no
// layout, so axe there cannot measure colour or scrolling, and those two
// rules are checked here instead: the colour by computing the ratio from the
// tokens in src/styles.css, the scrolling by reading the JSX.
//
// ── WHAT COUNTS AS NAMED ──────────────────────────────────────────────────
//
// A `<SelectTrigger>` or `<Switch>` is named when it carries `aria-label`,
// `aria-labelledby` or an `id` (which a `<Label htmlFor>` points at; when the
// id is a string literal the file must also contain that `htmlFor`), or when
// it sits inside a `<label>` / `<Label>` element, whose text names a button
// inside it. A spread (`{...props}`) is given the benefit of the doubt: the
// wrapper's caller decides.
//
// ── A RATCHET WITH A BACKLOG ──────────────────────────────────────────────
//
// The files axe named are clean. The rest of src/ is not yet, and
// `STILL_UNNAMED` lists them by count. It may only shrink: a new unnamed
// control in any file fails, and so does a listed file that has got BETTER
// without the list being updated, so the backlog cannot quietly overstate
// itself. gaps-r2-11 part 2 is that list.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const CONTROLS = new Set(["SelectTrigger", "Switch"]);
const LABELS = new Set(["label", "Label"]);

function tagName(n: ts.JsxOpeningLikeElement): string {
  return n.tagName.getText();
}

function attr(n: ts.JsxOpeningLikeElement, name: string): ts.JsxAttribute | undefined {
  return n.attributes.properties.find(
    (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
  );
}

function insideLabel(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isJsxElement(p) && LABELS.has(p.openingElement.tagName.getText())) return true;
  }
  return false;
}

/** `file:line Tag` for every unnamed control in one source text. */
function unnamedControls(text: string, file: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: string[] = [];
  const visit = (n: ts.Node) => {
    if ((ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) && CONTROLS.has(tagName(n))) {
      const spread = n.attributes.properties.some(ts.isJsxSpreadAttribute);
      const id = attr(n, "id");
      let named =
        spread || !!attr(n, "aria-label") || !!attr(n, "aria-labelledby") || insideLabel(n);
      if (!named && id) {
        const lit =
          id.initializer && ts.isStringLiteral(id.initializer) ? id.initializer.text : null;
        named = lit === null || text.includes(`htmlFor="${lit}"`);
      }
      if (!named) {
        const line = sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
        out.push(`${file}:${line} <${tagName(n)}>`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The backlog, by file. Shrinks only. */
const STILL_UNNAMED: Record<string, number> = {
  "src/components/DeleteAccountCard.tsx": 1,
  "src/components/ProvisionLocation.tsx": 1,
  "src/components/settings/ClientPortalCards.tsx": 4,
  "src/lib/portal-ui.tsx": 5,
  "src/routes/_authenticated/inventory.tsx": 4,
  "src/routes/_authenticated/settings.deep-clean.tsx": 1,
  "src/routes/_authenticated/settings.promotions.tsx": 2,
  "src/routes/_authenticated/settings.reviews.tsx": 1,
  "src/routes/platform.addons.tsx": 1,
  "src/routes/platform.announcements.tsx": 3,
  "src/routes/platform.coupons.tsx": 3,
  "src/routes/platform.invoices.tsx": 1,
  "src/routes/platform.plans.tsx": 2,
  "src/routes/platform.users.tsx": 1,
  "src/routes/platform.website-submissions.tsx": 1,
};

/** The files axe named in gaps-r2-11 (Clients filters, Preferences, the
 *  Business switch, the Schedule board's Display switches, Leads, the Team
 *  role select). These are at zero and stay there. */
const AXE_NAMED = [
  "src/routes/_authenticated/clients.index.tsx",
  "src/routes/_authenticated/settings.preferences.tsx",
  "src/routes/_authenticated/settings.business.tsx",
  "src/routes/_authenticated/routes.tsx",
  "src/routes/_authenticated/leads.tsx",
  "src/routes/_authenticated/settings.users.tsx",
];

describe("every Select trigger and Switch has a name", () => {
  const all = sourceFiles(join(root, "src")).flatMap((p) =>
    unnamedControls(readFileSync(p, "utf8"), repoRelative(p, root)),
  );
  const byFile = new Map<string, string[]>();
  for (const v of all) {
    const f = v.slice(0, v.indexOf(":"));
    byFile.set(f, [...(byFile.get(f) ?? []), v]);
  }

  it("in the files the audit named", () => {
    expect(all.filter((v) => AXE_NAMED.some((f) => v.startsWith(f + ":")))).toEqual([]);
  });

  it("and nowhere new (the backlog may only shrink)", () => {
    const worse = [...byFile].flatMap(([f, vs]) => (vs.length > (STILL_UNNAMED[f] ?? 0) ? vs : []));
    expect(worse).toEqual([]);
  });

  it("and the backlog says what is actually left", () => {
    const stale = Object.entries(STILL_UNNAMED)
      .filter(([f, n]) => (byFile.get(f)?.length ?? 0) !== n)
      .map(([f, n]) => `${f}: listed ${n}, found ${byFile.get(f)?.length ?? 0}`);
    expect(stale).toEqual([]);
  });

  it("the rule finds what it is for", () => {
    const bare = `export const A = () => <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>;`;
    expect(unnamedControls(bare, "x.tsx")).toEqual(["x.tsx:1 <SelectTrigger>"]);
    const orphan = `export const A = () => <Switch id="nope" />;`;
    expect(unnamedControls(orphan, "x.tsx")).toHaveLength(1);
    const ok = [
      `export const A = () => <SelectTrigger aria-label="Filter by status" />;`,
      `export const A = () => <Switch aria-labelledby="x" />;`,
      `export const A = () => <><Label htmlFor="m" /><SelectTrigger id="m" /></>;`,
      `export const A = () => <label>Weather <Switch /></label>;`,
    ];
    for (const s of ok) expect(unnamedControls(s, "x.tsx")).toEqual([]);
  });
});

// ── nested-interactive: a sortable card is not a button around buttons ────
//
// dnd-kit's `attributes` are role="button", tabIndex 0 and the "sortable"
// roledescription. Spread on the card's wrapper, they made the whole Schedule
// stop card a button containing the grip, the select checkbox and Complete.
// They belong on the drag handle, beside `listeners`.
describe("a sortable's attributes go on its handle", () => {
  it("no element that is the sortable node also spreads the attributes", () => {
    const offenders = sourceFiles(join(root, "src")).flatMap((p) => {
      const text = readFileSync(p, "utf8");
      if (!/useSortable|useDraggable/.test(text)) return [];
      return [
        ...text.matchAll(/<[A-Za-z]+\b[^>]*ref=\{setNodeRef\}[^>]*\{\.\.\.attributes\}/g),
      ].map((m) => `${repoRelative(p, root)}:${text.slice(0, m.index).split("\n").length}`);
    });
    expect(offenders).toEqual([]);
  });
});

// ── scrollable-region-focusable: Reports ──────────────────────────────────
describe("a Reports table that scrolls sideways can be reached by keyboard", () => {
  it("every overflow-x-auto card around a min-width table is a focusable, named region", () => {
    const text = read("src/routes/_authenticated/reports.tsx");
    const bad: number[] = [];
    const re = /<CardContent\b([^>]*overflow-x-auto[^>]*)>([\s\S]*?)<\/CardContent>/g;
    for (const m of text.matchAll(re)) {
      if (!m[2].includes("min-w-[")) continue;
      const tag = m[1];
      if (
        !tag.includes("tabIndex={0}") ||
        !/aria-label=/.test(tag) ||
        !tag.includes('role="region"')
      )
        bad.push(text.slice(0, m.index).split("\n").length);
    }
    expect(bad).toEqual([]);
  });
});

// ── color-contrast: the token the shared chrome uses on a tint ────────────
//
// Computed from the oklch values in src/styles.css, so a later edit to the
// token is measured rather than trusted. Composited the way a browser does:
// bg-primary/5 is primary at 5% over the background, in sRGB.
type Oklch = [number, number, number];
function oklchToSrgb([L, C, h]: Oklch): number[] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  return lin
    .map((v) => Math.min(1, Math.max(0, v)))
    .map((v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));
}
const luminance = (c: number[]) => {
  const [r, g, b] = c.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (x: number[], y: number[]) => {
  const [a, b] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return (a + 0.05) / (b + 0.05);
};
const over = (fg: number[], bg: number[], alpha: number) =>
  fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));

function tokens(block: "root" | "dark"): Record<string, Oklch> {
  const css = read("src/styles.css");
  const start =
    block === "root" ? css.indexOf(":root {\n  --radius") : css.indexOf(".dark {\n  --background");
  const body = css.slice(start, css.indexOf("}", start));
  const out: Record<string, Oklch> = {};
  for (const m of body.matchAll(/--([a-z-]+):\s*oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)/g))
    out[m[1]] = [Number(m[2]), Number(m[3]), Number(m[4])];
  return out;
}

describe("muted-foreground-strong clears 4.5:1 where the shared chrome puts it", () => {
  for (const mode of ["root", "dark"] as const) {
    it(`in ${mode === "root" ? "light" : "dark"} mode`, () => {
      const t = tokens(mode);
      const fg = oklchToSrgb(t["muted-foreground-strong"]);
      const bg = oklchToSrgb(t["background"]);
      const surfaces = {
        background: bg,
        muted: oklchToSrgb(t["muted"]),
        "primary/5 (setup banner)": over(oklchToSrgb(t["primary"]), bg, 0.05),
      };
      const low = Object.entries(surfaces)
        .map(([k, s]) => [k, Number(ratio(fg, s).toFixed(2))] as const)
        .filter(([, r]) => r < 4.5);
      expect(low).toEqual([]);
    });
  }

  it("is what the setup banner, the ⌘K hint and the tab bar labels use", () => {
    const banner = read("src/components/SetupGuideBanner.tsx");
    expect(banner).not.toMatch(/className="text-muted-foreground">/);
    expect(banner.match(/text-muted-foreground-strong/g)?.length).toBe(2);

    const shell = read("src/routes/_authenticated/route.tsx");
    const kbd = shell.slice(shell.indexOf("<kbd"), shell.indexOf("</kbd>"));
    expect(kbd).toContain("text-muted-foreground-strong");
    expect(kbd).toContain('aria-hidden="true"');

    const tabBar = read("src/components/MobileTabBar.tsx");
    expect(tabBar).toMatch(/active \? "text-primary" : "text-muted-foreground-strong/);
  });
});
