/**
 * Every signed-in page starts and ends at the same x, at every width.
 *
 * ── THE COMPLAINT ─────────────────────────────────────────────────────────
 *
 * The owner, 2026-10-02: "It still doesn't seem every page is consistent; I
 * am noticing a ton of inconsistency such as the margins, padding, and
 * overflow. The page widths should be identically the same when viewing it on
 * the same size screen."
 *
 * Measured the day it was said, at 1920px across 63 signed-in pages: the
 * content column started at seven different x positions and ended at nine,
 * and the page heading sat at eight. The shell gave every page the same
 * 1600px column, and then 21 pages put a column of their own inside it —
 * `mx-auto max-w-2xl` (centred, 672px), `max-w-2xl` (left-aligned, 672px),
 * `max-w-3xl`, `max-w-4xl`, `max-w-5xl`, `max-w-6xl`, and My Day's `-mx-4` —
 * each one somebody's reasonable reading measure, and together a product
 * whose heading jumped 464px sideways between Clients and New client. None of
 * the other sweeps could see it: every one of them asks whether a page FITS,
 * and a page in a narrower column fits.
 *
 * ── WHAT THIS HOLDS ───────────────────────────────────────────────────────
 *
 * `src/components/PageShell.tsx` is the one place a page's column is decided
 * — max width, horizontal padding, top padding, the gap between sections —
 * and the `_authenticated` layout wraps it round every page. It marks its
 * column `data-page-shell="standard" | "wide"`. At each width every page is
 * measured and compared with /dashboard:
 *
 *   * EXACTLY ONE SHELL. None means the page drew its own column; two means a
 *     layout and its child both wrapped, and the padding doubled.
 *   * THE SAME LEFT EDGE for both variants, and the same RIGHT edge for the
 *     same variant. "Wide" lifts the 1600px cap and nothing else, so a wide
 *     page may end further right than a standard one, never less far.
 *   * THE PAGE'S HEADER STARTS AT THE COLUMN'S LEFT EDGE — the leftmost thing
 *     you can see in the section holding the heading. A page that adds
 *     `px-8` inside the shell moves this and nothing else, so this is what
 *     catches it. (Not the h1 itself: on /clients/:id an avatar sits in front
 *     of it and on /invoices/:id a back button does, both on the column edge.)
 *   * EVERY TOP-LEVEL SECTION STARTS AT THE LEFT EDGE, and at least one
 *     reaches the right edge. A page whose every section stops short has
 *     drawn a narrower column inside the shell — the old fault in new code.
 *   * NOTHING IS DRAWN OUTSIDE THE COLUMN, and when something is, the failure
 *     names the outermost element that escaped, not the dozen inside it.
 *     This is the overflow half of the complaint. On its first full run it
 *     found three faults that predated the shell and had been passing every
 *     other sweep: /expenses' category amounts and /settings/blackouts' "Add
 *     blackout" ran ~10px past the right edge at 768, and /analytics' tab bar
 *     was 718px wide in a 464px column, clipped by an `overflow-x-hidden` on
 *     the page root so the last tabs could not be reached at all.
 *
 * MUTATION-CHECKED when it landed, against /expenses with the dashboard as
 * the reference:
 *
 *   * its root given `px-10` — failed at all four widths, "the page's header
 *     starts at x=56, the column at 16" (and 320 against 280 from 768 up);
 *   * its root given `mx-auto max-w-2xl`, the exact wrapper 21 pages carried —
 *     failed at 1280 and 1920 (header at 432 and 744 against 280), and passed
 *     at 360 and 768, where a 672px cap is wider than the column and changes
 *     nothing. That is the honest answer, not a gap: at those widths the page
 *     WAS where every other page was.
 *
 * Both reverted and green.
 *
 * ── HOW THE PAGES ARE CHOSEN ──────────────────────────────────────────────
 *
 * From the route files, like `every-route-nobody-put-on-the-list.spec.ts`, so
 * a page added tomorrow is measured tomorrow — plus the parameterised routes,
 * with ids the fixture actually has. A list is the thing that failed last
 * time.
 *
 * ── WHAT IT DELIBERATELY DOES NOT CHECK ───────────────────────────────────
 *
 * Whether the content INSIDE a section is as wide as the section. A form
 * whose fields stop at a readable width, a card grid with three columns, a
 * paragraph held to a measure — those are layout decisions inside a column
 * that is the same column everywhere. The complaint was about the column.
 *
 * The measurements are also written out (PAGE_EDGES_OUT=<dir>) so the
 * before/after table in the PR that introduced the shell could be built from
 * the same code that now guards it.
 */
import { test, expect, type Page } from "@playwright/test";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { WIDTHS } from "./rules";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import {
  CAMPAIGN_SENT_ID,
  CLIENT_ID,
  PROPERTY_ID,
  QUOTE_ACCEPTED_ID,
  REFUND_INVOICE_ID,
} from "./fixtures/dataset";

/** Routes that redirect somewhere else, so have no layout of their own. Same
 *  list, same reason, as the unlisted-route sweep. */
const REDIRECTS = new Set(["settings", "settings/payments", "ai-tools", "billing"]);

const LEAF_PAGES = readdirSync(join(import.meta.dirname, "../../src/routes/_authenticated"))
  .filter((f) => f.endsWith(".tsx"))
  .map((f) => f.slice(0, -".tsx".length))
  .filter((f) => f !== "route" && f !== "index" && !f.includes("$"))
  .map((f) => f.replace(/\.index$/, "").replace(/\./g, "/"))
  .filter((p) => p && !REDIRECTS.has(p))
  .filter((p, i, all) => all.indexOf(p) === i)
  .sort();

/** The parameterised routes, each with an id the stub answers for. */
const PARAM_PAGES = [
  `clients/${CLIENT_ID}`,
  `invoices/${REFUND_INVOICE_ID}`,
  `quotes/${QUOTE_ACCEPTED_ID}`,
  `campaigns/${CAMPAIGN_SENT_ID}`,
  `messages/${CLIENT_ID}`,
  `properties/${PROPERTY_ID}/boundary`,
];

const PAGES = [...LEAF_PAGES, ...PARAM_PAGES];

export type Edges = {
  path: string;
  /** `data-page-shell` values found, outermost first. */
  shells: string[];
  /** The shell's CONTENT box — inside its padding — which is where a page's
   *  content is supposed to start and end. */
  shellLeft: number | null;
  shellRight: number | null;
  /** Union of everything visible in the shell's column (or, before there was
   *  one, in <main>), clipped by any scroll container it sits in. What the
   *  eye reads as "where the page is". */
  contentLeft: number;
  contentRight: number;
  /** The page's h1 (else h2). Reported; an icon or a back button may
   *  legitimately sit in front of it, so it is not what is asserted. */
  headingX: number | null;
  headingTag: string | null;
  /** Where the page's HEADER starts: the leftmost visible thing inside the
   *  top-level section holding the heading (or the first section). This is
   *  what an extra `px-8` inside the shell moves, and what is asserted. */
  headerX: number | null;
  /** The outermost elements drawn outside the column — the ones whose
   *  parent still fits — so a failure names a cause and not its symptoms. */
  escapees: string[];
  mainLeft: number;
  mainRight: number;
  /** The narrowest pixel max-width between the heading and <main>, or the
   *  shell's own when there is no heading. */
  maxWidth: number | null;
  /** Direct children of the shell that do not start at its left edge — or,
   *  when NONE of them reaches its right edge, a note saying so. */
  childrenOff: string[];
  /** The column the page's content is actually held to: the outermost
   *  container within four levels of the shell (or, before it, of <main>'s
   *  own wrapper) that has a pixel max-width under 1600 and holds at least
   *  two blocks. `max-w-2xl` on a settings section, `mx-auto max-w-3xl` on a
   *  quote. Null when nothing narrows the page. Reported, not asserted —
   *  the assertions above are stricter — and kept because it is the number
   *  the owner was describing. */
  column: { left: number; right: number; maxWidth: number; className: string } | null;
};

async function measureEdges(page: Page): Promise<Edges> {
  return page.evaluate(() => {
    const r1 = (n: number) => Math.round(n * 10) / 10;
    const main = document.querySelector("main") as HTMLElement;
    const mainRect = main.getBoundingClientRect();

    // A declared bleed (PAGE_BLEED_X in PageShell.tsx) runs edge to edge on
    // purpose and pads its contents back in by exactly the gutter, so it is
    // measured by its CONTENT box: where what is inside it starts and ends.
    const boxOf = (el: Element) => {
      const rect = el.getBoundingClientRect();
      if (!el.hasAttribute("data-page-bleed")) return { left: rect.left, right: rect.right };
      const cs = getComputedStyle(el);
      return {
        left: rect.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth),
        right: rect.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth),
      };
    };

    const name = (k: Element) =>
      `${k.tagName.toLowerCase()}${
        k.getAttribute("class")
          ? `.${String(k.getAttribute("class")).trim().split(/\s+/).slice(0, 4).join(".")}`
          : ""
      }`;

    const shellEls = [...main.querySelectorAll<HTMLElement>("[data-page-shell]")];
    const shell = shellEls[0] ?? null;
    let shellLeft: number | null = null;
    let shellRight: number | null = null;
    const childrenOff: string[] = [];
    if (shell) {
      const r = shell.getBoundingClientRect();
      const cs = getComputedStyle(shell);
      shellLeft = r.left + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
      shellRight = r.right - parseFloat(cs.paddingRight) - parseFloat(cs.borderRightWidth);
      const kids = [...shell.children].filter((k) => {
        const kr = k.getBoundingClientRect();
        const kcs = getComputedStyle(k);
        return (
          kr.width > 0 && kr.height > 0 && kcs.position !== "fixed" && kcs.position !== "absolute"
        );
      });
      let reachesRight = kids.length === 0;
      for (const k of kids) {
        const kr = boxOf(k);
        if (Math.abs(kr.left - shellLeft!) > 1) {
          childrenOff.push(`${name(k)} starts at x=${r1(kr.left)}, the shell at ${r1(shellLeft!)}`);
        }
        if (Math.abs(kr.right - shellRight!) <= 1) reachesRight = true;
      }
      // One section narrower than the column is a layout decision (a back
      // link, a row of chips). EVERY section narrower than it is a page that
      // drew a column of its own inside the shell.
      if (!reachesRight) {
        childrenOff.push(
          `no top-level section reaches the shell's right edge at ${r1(shellRight!)}: ` +
            kids.map((k) => `${name(k)} ends at ${r1(boxOf(k).right)}`).join("; "),
        );
      }
    }

    // Union of visible boxes, each clipped by every ancestor that clips.
    // Measured inside the column when there is one — the shell's own padded
    // wrapper spans the gutter, and is not content.
    const scope: HTMLElement = shell ?? main;
    const clipped = (el: HTMLElement, start: { left: number; right: number } = boxOf(el)) => {
      let { left: l, right: r } = start;
      for (let a = el.parentElement; a && a !== main; a = a.parentElement) {
        const acs = getComputedStyle(a);
        if (acs.position === "fixed") return null;
        if (acs.overflowX !== "visible") {
          const ar = a.getBoundingClientRect();
          l = Math.max(l, ar.left);
          r = Math.min(r, ar.right);
        }
      }
      return r - l < 2 ? null : { l, r };
    };
    // Only what the eye can SEE counts. A transparent box draws nothing: a
    // ghost button pulled out by `-mx-2 px-2` so its hover tint has room has
    // its LABEL on the column edge, and a scroller given `-mx-1 px-1` so a
    // focus ring is not clipped has its chips there too. Text, media,
    // controls, and anything with a border, a fill or a shadow are measured;
    // empty wrappers are measured through what they contain.
    const painted = (el: HTMLElement, cs: CSSStyleDeclaration) => {
      if (/^(IMG|SVG|VIDEO|CANVAS|IFRAME|INPUT|SELECT|TEXTAREA)$/i.test(el.tagName)) {
        return boxOf(el);
      }
      if (el.closest("svg") && el.tagName.toLowerCase() !== "svg") return null;
      const side = (w: string, st: string) => parseFloat(w) > 0 && st !== "none";
      if (
        side(cs.borderLeftWidth, cs.borderLeftStyle) ||
        side(cs.borderRightWidth, cs.borderRightStyle) ||
        side(cs.borderTopWidth, cs.borderTopStyle) ||
        side(cs.borderBottomWidth, cs.borderBottomStyle) ||
        !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ||
        cs.backgroundImage !== "none" ||
        cs.boxShadow !== "none"
      ) {
        return boxOf(el);
      }
      // Text: where the GLYPHS are, not the box around them.
      let l = Infinity;
      let r = -Infinity;
      for (const n of el.childNodes) {
        if (n.nodeType !== Node.TEXT_NODE || !(n.textContent ?? "").trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(n);
        const tr = range.getBoundingClientRect();
        if (tr.width < 1) continue;
        l = Math.min(l, tr.left);
        r = Math.max(r, tr.right);
      }
      if (!Number.isFinite(l)) return null;
      // A truncated line's glyphs run on past the ellipsis; the element's own
      // overflow is what stops them being seen.
      if (cs.overflowX !== "visible") {
        const own = el.getBoundingClientRect();
        l = Math.max(l, own.left);
        r = Math.min(r, own.right);
      }
      return r - l < 1 ? null : { left: l, right: r };
    };
    const visibleAtAll = (el: HTMLElement) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) return null;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.position === "fixed") return null;
      if (cs.clip === "rect(0px, 0px, 0px, 0px)" || cs.clipPath === "inset(50%)") return null;
      return cs;
    };
    /** The painted, clipped extent of one element, or null if it draws
     *  nothing you could see. */
    const seen = (el: HTMLElement) => {
      const cs = visibleAtAll(el);
      if (!cs) return null;
      const p = painted(el, cs);
      return p ? clipped(el, p) : null;
    };
    const unionOf = (root: HTMLElement) => {
      let l = Infinity;
      let r = -Infinity;
      for (const el of root.querySelectorAll<HTMLElement>("*")) {
        const b = seen(el);
        if (!b) continue;
        l = Math.min(l, b.l);
        r = Math.max(r, b.r);
      }
      return { l, r };
    };
    const { l: left, r: right } = unionOf(scope);

    const escapees: string[] = [];
    if (shell) {
      for (const el of shell.querySelectorAll<HTMLElement>("*")) {
        const b = seen(el);
        if (!b || (b.l >= shellLeft! - 1 && b.r <= shellRight! + 1)) continue;
        const parent = el.parentElement!;
        const pb = parent === shell ? null : seen(parent);
        if (pb && (pb.l < shellLeft! - 1 || pb.r > shellRight! + 1)) continue;
        escapees.push(`${name(el)} spans ${r1(b.l)}–${r1(b.r)}`);
        if (escapees.length >= 3) break;
      }
    }

    const visible = (h: Element) => {
      const r = h.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    const heading =
      [...main.querySelectorAll("h1")].find(visible) ??
      [...main.querySelectorAll("h2")].find(visible) ??
      null;

    let column: Edges["column"] = null;
    {
      const root = shell ?? main.firstElementChild ?? main;
      let level: Element[] = [...root.children];
      for (let depth = 0; depth < 4 && !column && level.length; depth++) {
        const next: Element[] = [];
        for (const el of level) {
          const tag = el.tagName.toLowerCase();
          const mw = getComputedStyle(el).maxWidth;
          const rect = el.getBoundingClientRect();
          const blocks = [...el.children].filter((c) => c.getBoundingClientRect().height > 0);
          if (
            ["div", "section", "form", "article"].includes(tag) &&
            mw.endsWith("px") &&
            parseFloat(mw) < 1600 &&
            rect.width >= 240 &&
            blocks.length >= 2
          ) {
            column = {
              left: r1(rect.left),
              right: r1(rect.right),
              maxWidth: parseFloat(mw),
              className: String(el.getAttribute("class") ?? ""),
            };
            break;
          }
          next.push(...el.children);
        }
        level = next;
      }
    }

    let headerX: number | null = null;
    if (shell) {
      let section: Element | null = heading;
      while (section && section.parentElement !== shell) section = section.parentElement;
      section ??= [...shell.children].find((k) => visibleAtAll(k as HTMLElement)) ?? null;
      if (section) {
        // A card — a border or a background you can see — is measured by its
        // own edge: its content is inset from a line the eye reads, which is
        // what a card is. Padding on NOTHING is an invisible gutter, and that
        // is measured where the content inside it starts.
        const cs = getComputedStyle(section);
        const visibleBox =
          (parseFloat(cs.borderLeftWidth) > 0 && cs.borderLeftStyle !== "none") ||
          !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor) ||
          cs.backgroundImage !== "none";
        const u = visibleBox ? { l: boxOf(section).left } : unionOf(section as HTMLElement);
        if (Number.isFinite(u.l)) headerX = r1(u.l);
      }
    }

    let maxWidth: number | null = null;
    const from: Element | null = heading ?? shell;
    for (let a: Element | null = from; a && a !== main; a = a.parentElement) {
      const mw = getComputedStyle(a).maxWidth;
      if (mw.endsWith("px")) {
        const v = parseFloat(mw);
        maxWidth = maxWidth === null ? v : Math.min(maxWidth, v);
      }
    }

    return {
      path: location.pathname,
      shells: shellEls.map((s) => s.dataset.pageShell ?? ""),
      shellLeft: shellLeft === null ? null : r1(shellLeft),
      shellRight: shellRight === null ? null : r1(shellRight),
      contentLeft: r1(left),
      contentRight: r1(right),
      headingX: heading ? r1(heading.getBoundingClientRect().left) : null,
      headingTag: heading ? heading.tagName.toLowerCase() : null,
      headerX,
      escapees,
      mainLeft: r1(mainRect.left),
      mainRight: r1(mainRect.right),
      maxWidth,
      column,
      childrenOff,
    };
  });
}

async function openAndMeasure(page: Page, path: string): Promise<Edges> {
  await page.goto(`/${path}`);
  await page.waitForLoadState("networkidle").catch(() => {});
  // The shell's own <main> — on /auth and /no-workspace there is none, so a
  // bounced session fails here rather than measuring the login form.
  await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });
  await page
    .locator("main h1, main h2")
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {});
  await page.waitForTimeout(500);
  expect(new URL(page.url()).pathname, `/${path} redirected`).toBe(`/${path}`);
  const threw = await page.evaluate(() => document.body.innerText.includes("Something went wrong"));
  expect(threw, `/${path} rendered the router's error boundary, not the page`).toBe(false);
  return measureEdges(page);
}

const OUT = process.env.PAGE_EDGES_OUT;

/** The reference every page is compared with. The dashboard is the page
 *  people land on; if it is wrong, every comparison says so. */
const REFERENCE = "dashboard";

test.describe.configure({ mode: "parallel" });

for (const { w, h, label } of WIDTHS) {
  test.describe(label, () => {
    let reference: Edges | null = null;

    test.beforeEach(async ({ context }) => {
      await installSignedInSession(context);
      await installStubBackend(context);
    });

    async function referenceEdges(page: Page): Promise<Edges> {
      if (!reference) {
        await page.setViewportSize({ width: w, height: h });
        reference = await openAndMeasure(page, REFERENCE);
      }
      return reference;
    }

    for (const path of PAGES) {
      test(`/${path} at ${w}px starts and ends where every other page does`, async ({ page }) => {
        const ref = await referenceEdges(page);
        await page.setViewportSize({ width: w, height: h });
        const m = await openAndMeasure(page, path);

        if (OUT) {
          mkdirSync(OUT, { recursive: true });
          writeFileSync(
            join(OUT, `${w}-${path.replace(/\//g, "__")}.json`),
            JSON.stringify({ width: w, ...m }, null, 2),
          );
        }

        const where = `/${path} at ${w}px`;
        expect(m.shells, `${where}: exactly one PageShell, not ${m.shells.length}`).toHaveLength(1);
        expect(ref.shells, `the reference page /${REFERENCE} has no PageShell`).toHaveLength(1);

        // Left: the same gutter for both variants.
        expect(m.shellLeft, `${where}: the column starts at a different x from /${REFERENCE}`).toBe(
          ref.shellLeft,
        );
        // Right: the same for the same variant. A wide page may run further
        // right than a standard one, never less far.
        if (m.shells[0] === ref.shells[0]) {
          expect(
            m.shellRight,
            `${where}: the column ends at a different x from /${REFERENCE}`,
          ).toBe(ref.shellRight);
        } else {
          expect(m.shells[0], `${where}: an unknown shell variant`).toBe("wide");
          expect(
            m.shellRight!,
            `${where}: a wide page ends left of a standard one`,
          ).toBeGreaterThanOrEqual(ref.shellRight!);
        }

        expect(
          m.headerX,
          `${where}: nothing in the page's first section to measure`,
        ).not.toBeNull();
        expect(
          m.headerX,
          `${where}: the page's header starts at x=${m.headerX}, the column at ${m.shellLeft}`,
        ).toBe(m.shellLeft);
        expect(
          m.childrenOff,
          `${where}: a section inside the shell drew a column of its own`,
        ).toEqual([]);
        // And nothing in the page escapes the column sideways.
        expect(
          m.escapees,
          `${where}: drawn outside the column (${m.shellLeft}–${m.shellRight}) — content spans ${m.contentLeft}–${m.contentRight}`,
        ).toEqual([]);
      });
    }
  });
}
