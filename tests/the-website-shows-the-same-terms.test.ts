// The website shows the same terms.
//
// There are two Terms of Service pages and one document (pal-primer#393): the
// app's /legal/terms is canonical, and www.houndstack.com/terms is a copy in
// another repo. On 2026-10-10 the copy had drifted in three places, and the
// lawyer asked which one to read. scripts/check-terms-live.mjs asks the LIVE
// site on every push to main and fails on a changed word; that needs a
// network, so it runs from ci.yml's deployment job and not from here.
//
// What this file pins, with no network, is the part that can rot quietly:
//
//   * the normaliser reads legal.terms.tsx correctly today, and will THROW
//     rather than compare a sentence with a hole in it when somebody adds a
//     JSX expression it does not know;
//   * the site-side reducer strips exactly the three things the copy is
//     allowed to add and nothing else, so a real drift is reported and the
//     "This is a copy of ..." line is not;
//   * the script is wired: a check nobody runs is the shape of fault
//     check:pwa:live was once (tests/the-worker-that-was-never-served.test.ts).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalTermsText,
  firstDifference,
  flattenMarkup,
  siteTermsText,
} from "../scripts/terms-text.mjs";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/** What Astro's build of the site's terms.astro looks like, in miniature:
 *  the eyebrow, the heading, the date, the copy-of line, then prose with
 *  entities and a link whose href differs from the app's. */
function siteHtml(body: string, copyOf = true) {
  return (
    '<main><section class="page-hero" data-astro-cid-x><div class="container-narrow prose" data-astro-cid-x>' +
    '<span class="eyebrow" data-astro-cid-x>Legal</span><h1 data-astro-cid-x>Terms of Service</h1>' +
    '<p class="muted" data-astro-cid-x>Last updated: October 10, 2026</p>' +
    (copyOf
      ? '<p class="muted copy-of" data-astro-cid-x>This is a copy of <a href="https://app.houndstack.com/legal/terms">app.houndstack.com/legal/terms</a>, the canonical Terms of Service.</p>'
      : "") +
    body +
    "</div></section></main>"
  );
}

describe("the canonical text", () => {
  const text = canonicalTermsText(root);

  it("starts with the date and carries the clauses the lawyer is reviewing", () => {
    expect(text).toMatch(/^Last updated: [A-Z][a-z]+ \d{1,2}, \d{4} These terms govern/);
    expect(text).toContain("The free trial lasts 14 days.");
    expect(text).toContain("Yearly plans are not refunded.");
    expect(text).toContain("export your data for 30 days, after which it may be deleted.");
    expect(text).toContain("SMS Consent & Messaging Policy");
    expect(text).toContain("HoundStack's own number");
  });

  it("is prose: no tag, no entity, no JSX left in it", () => {
    expect(text).not.toMatch(/[<>{}]/);
    expect(text).not.toMatch(/&[a-z#0-9]+;/);
    expect(text).not.toMatch(/\s{2}/);
  });

  it("refuses a JSX expression it cannot render rather than dropping it", () => {
    // Every expression the route uses today is one the normaliser knows.
    const route = read("src/routes/legal.terms.tsx");
    const body = route.slice(route.indexOf("<LegalShell"), route.indexOf("</LegalShell>"));
    const exprs = [...body.matchAll(/\{[^}]*\}/g)].map((m) => m[0]);
    expect(new Set(exprs)).toEqual(new Set(["{APP_NAME}", '{" "}']));
  });
});

describe("the site's page, reduced", () => {
  it("drops the eyebrow, the heading and the copy-of line, and keeps the date", () => {
    const got = siteTermsText(siteHtml("<p>These terms govern your use of HoundStack.</p>"));
    expect(got).toBe("Last updated: October 10, 2026 These terms govern your use of HoundStack.");
  });

  it("does not care about hrefs, entities or whitespace between tags", () => {
    const a = siteTermsText(
      siteHtml(
        '<p>See the <a href="/sms-consent">SMS Consent &amp; Messaging Policy</a>.</p>\n' +
          "      <ul>\n        <li>one</li>\n        <li>two</li>\n      </ul>",
      ),
    );
    const b = flattenMarkup(
      'Last updated: October 10, 2026<p>See the{" "}<a href="/legal/sms">SMS Consent &amp; Messaging Policy</a>.</p><ul><li>one</li><li>two</li></ul>'.replace(
        /\{" "\}/g,
        " ",
      ),
    );
    expect(a).toBe(b);
  });

  it("is null, not empty, when the prose container is gone", () => {
    expect(siteTermsText("<main><h1>Terms</h1><p>moved</p></main>")).toBeNull();
  });

  it("reports the first changed word, so a drift is a diff and not a boolean", () => {
    const app =
      "Last updated: October 10, 2026 export your data for 30 days, after which it may be deleted.";
    const site =
      "Last updated: October 10, 2026 export your data for 30 days before it is deleted.";
    const d = firstDifference(app, site);
    // "days," against "days": the comma is the first word that differs.
    expect(d?.word).toBe(10);
    expect(d?.a).toContain("after which");
    expect(d?.b).toContain("before it");
    expect(firstDifference(app, app)).toBeNull();
  });
});

describe("the check is wired", () => {
  it("has an npm script and runs from the deployment job on main", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["check:terms:live"]).toBe("node scripts/check-terms-live.mjs");
    const ci = read(".github/workflows/ci.yml");
    const start = ci.indexOf("\n  deployment:");
    expect(start, "ci.yml has no deployment job").toBeGreaterThan(-1);
    // Up to the next top-level job key (two spaces, a name, a colon), or the end.
    const next = /\n  [a-z_-]+:\s*\n/.exec(ci.slice(start + 1));
    const job = ci.slice(start, next ? start + 1 + next.index : undefined);
    expect(job).toMatch(/run: npm run check:terms:live/);
    expect(job).toMatch(/if: github\.event_name != 'pull_request'/);
  });
});
