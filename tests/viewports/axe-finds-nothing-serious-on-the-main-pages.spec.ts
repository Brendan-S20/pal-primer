import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AxeResults } from "axe-core";
import { installSignedInSession } from "./fixtures/session";
import { installStubBackend } from "./fixtures/stub-backend";
import { SURFACES } from "./fixtures/surfaces";
import { settle, openExtras } from "./fixtures/settle-surface";

/**
 * axe-core, in a real browser, over the signed-in pages people actually work
 * in (gaps-r2-11, part 2).
 *
 * ── WHY A BROWSER AND NOT JSDOM ───────────────────────────────────────────
 *
 * Part 1 (#709) scans the SHARED pieces in jsdom, and says of itself that
 * jsdom has no layout, so axe there cannot measure colour or scrolling. The
 * round-2 audit's two biggest rules were exactly those: color-contrast and
 * the names of controls. Contrast is a computed foreground over a computed,
 * composited background; only a browser that has laid the page out knows
 * either. So this is the other half: the same surfaces the responsiveness
 * sweep measures (`fixtures/surfaces.ts`), the same minted session and
 * stubbed backend, the same proof-of-render guard — and axe's WCAG 2.1 A/AA
 * rules over what rendered.
 *
 * ── WHAT FAILS ────────────────────────────────────────────────────────────
 *
 * A serious or critical violation of a WCAG 2.0/2.1 A or AA rule. Moderate
 * and minor findings (landmark and heading best-practice) are not WCAG
 * failures and are not this check's business. A failure names the rule,
 * the file and line of the JSX that drew the element (the dev build stamps
 * it), and axe's own one-line summary, which for color-contrast includes
 * the two colours and the ratio.
 *
 * ── ONE DEFERRED LIST, AND WHY IT EXISTS ──────────────────────────────────
 *
 * Part 1 (#709) changed a set of files, and part 2 was written not to
 * touch them so the two could merge in either order. Some findings live in
 * exactly those files and #709 did not fix them. `DEFERRED` names them by
 * rule and file, and nothing else is tolerated: they are part 3. The
 * entries #709 itself fixed were deleted when it landed. The list may only
 * shrink: when an entry stops being found, delete it.
 *
 * ── WHAT IS DELIBERATELY LEFT OUT ─────────────────────────────────────────
 *
 *   * /platform/*. The operator console is staff of HoundStack, not of the
 *     business, and is not a "main app page".
 *   * Two widths, not four. 1280 is the desktop layout (sidebar, tables);
 *     360 is the phone layout (tab bar, card lists, sheets). 768 and 1920
 *     draw the same controls as one of those two; what differs between them
 *     is geometry, which the responsiveness sweep owns.
 *
 * ── RUNNING IT ────────────────────────────────────────────────────────────
 *
 *     npm run test:viewports:axe
 */

const require = createRequire(import.meta.url);
const AXE_SOURCE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

const WCAG_A_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const FAILING_IMPACT = new Set(["serious", "critical"]);

const SIZES = [
  { w: 1280, h: 800, label: "desktop 1280" },
  { w: 360, h: 780, label: "phone 360" },
];

const AXE_SURFACES = SURFACES.filter((s) => !s.path.startsWith("/platform"));

test.describe.configure({ mode: "parallel" });

/** `rule @ file` findings left in the files #709 changed (part 3). Not a
 *  backlog to grow: a new finding anywhere else, or a new rule in one of
 *  these files, fails. */
const DEFERRED = new Set([
  // Still found with #709 merged (measured 2026-11-09, and again once #709
  // was on main on 2026-11-10): part 3.
  //   Users & roles: the Select at 241 (button-name) and a native <select>
  //   at 440 with no label. Clients list: amber-600 / emerald-600 billing
  //   and balance text on white (3.2:1 / 3.69:1). Reports: amber-600 and
  //   orange-600 figures on white. Tab bar: the active tab's label on its
  //   pill, 3.93:1.
  "button-name @ src/routes/_authenticated/settings.users.tsx",
  "select-name @ src/routes/_authenticated/settings.users.tsx",
  "color-contrast @ src/routes/_authenticated/clients.index.tsx",
  "color-contrast @ src/routes/_authenticated/reports.tsx",
  "color-contrast @ src/components/MobileTabBar.tsx",
]);

type Finding = {
  id: string;
  impact: string;
  source: string | null;
  target: string;
  summary: string;
};

/** Serious/critical WCAG A/AA violations, one per rule × element. */
async function axeViolations(page: Page): Promise<Finding[]> {
  await page.addScriptTag({ content: AXE_SOURCE });
  const found = await page.evaluate(
    async ({ tags, impacts }) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const results: AxeResults = await (window as any).axe.run(document, {
        runOnly: { type: "tag", values: tags },
        resultTypes: ["violations"],
      });
      const out: Finding[] = [];
      for (const v of results.violations) {
        if (!impacts.includes(v.impact ?? "")) continue;
        for (const n of v.nodes) {
          // The dev build stamps every element with the JSX that drew it,
          // which is the line to go and fix; a selector rarely says. Read
          // from the DOM rather than from axe's `html`, which truncates long
          // attribute values.
          const sel = n.target[n.target.length - 1];
          const el = typeof sel === "string" ? document.querySelector(sel) : null;
          out.push({
            id: v.id,
            impact: v.impact ?? "",
            source: el?.getAttribute("data-tsd-source") ?? null,
            target: n.target.join(" "),
            summary: n.failureSummary ?? "",
          });
        }
      }
      return out;
    },
    { tags: WCAG_A_AA, impacts: [...FAILING_IMPACT] },
  );
  return found;
}

/** `rule @ file`, the key DEFERRED is written in. */
const deferredKey = (f: Finding) =>
  `${f.id} @ ${(f.source ?? "").replace(/^\//, "").replace(/:\d+:\d+$/, "")}`;

function explain(f: Finding): string {
  const summary = f.summary
    .replace(/^Fix (any|all) of the following:\s*/gm, "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 2)
    .join(" / ");
  const where = f.source ? `@ ${f.source.replace(/^\//, "")}` : f.target;
  return `${f.id} (${f.impact}): ${where} — ${summary}`;
}

function collapse(findings: string[]): string[] {
  const counts = new Map<string, number>();
  for (const f of findings) counts.set(f, (counts.get(f) ?? 0) + 1);
  return [...counts].map(([f, n]) => (n === 1 ? f : `${f}   [×${n}]`));
}

for (const { w, h, label } of SIZES) {
  test.describe(label, () => {
    for (const surface of AXE_SURFACES) {
      test(`${surface.id} has no serious axe violation at ${w}px`, async ({ page, context }) => {
        await installSignedInSession(context, surface.prefs);
        await installStubBackend(context);
        await page.setViewportSize({ width: w, height: h });
        await page.goto(surface.path);
        await settle(page, surface, label);
        await openExtras(page, surface, label);

        const all = await axeViolations(page);
        const deferred = all.filter((f) => DEFERRED.has(deferredKey(f)));
        if (deferred.length) {
          test.info().annotations.push({
            type: "deferred to #709's files",
            description: collapse(deferred.map(explain)).join("\n"),
          });
        }

        expect(
          collapse(all.filter((f) => !DEFERRED.has(deferredKey(f))).map(explain)),
          `${surface.id} at ${w}px: serious/critical WCAG A/AA violations`,
        ).toEqual([]);
      });
    }
  });
}
