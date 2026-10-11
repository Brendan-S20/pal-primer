#!/usr/bin/env node
// Does www.houndstack.com/terms say what src/routes/legal.terms.tsx says?
//
// The app's /legal/terms is the one Terms of Service (pal-primer#393). The
// marketing site keeps a copy because the app's legal pages are noindex and
// the site's footer and sitemap point at /terms. A copy in another repo
// drifts, and nothing in either repo can see the other at build time: both
// are private, the site builds on Vercel with no token for this one, and this
// one's tests must not depend on a sibling checkout. What CAN be seen from
// here is the site as served, which is static HTML with the prose in it.
//
// So this asks the live site and compares it, word for word, with this repo's
// source. Run from ci.yml's `deployment` job on main, next to check:pwa:live,
// and by hand after editing either copy:
//
//     npm run check:terms:live
//
// Exit code is 1 when the site ANSWERS and the words differ (or the page has
// no prose container at all), and 0 when it cannot be reached, so a network
// blip cannot fail a build. Same policy as check-pwa-live.mjs, for the same
// reason. The ordering it implies is deliberate: change the app's terms
// first, merge, then paste the change into the site; main is red in between,
// which is the drift being visible rather than silent.
//
// TERMS_ORIGIN overrides the host, for a Vercel preview URL.

import { canonicalTermsText, firstDifference, siteTermsText } from "./terms-text.mjs";

const ORIGIN = process.env.TERMS_ORIGIN ?? "https://www.houndstack.com";
const PATH = "/terms";

const expected = canonicalTermsText(process.cwd());

let res;
try {
  res = await fetch(ORIGIN + PATH, {
    headers: { accept: "text/html" },
    signal: AbortSignal.timeout(20_000),
  });
} catch (e) {
  console.log(`\n${ORIGIN}${PATH}: unreachable (${e.message}); nothing to compare.\n`);
  process.exit(0);
}

console.log(`\n${ORIGIN}${PATH}  ${res.status}`);
if (res.status !== 200) {
  console.error(`  expected 200. The site answered, and the Terms page is not there.\n`);
  process.exit(1);
}

const actual = siteTermsText(await res.text());
if (actual === null) {
  console.error(
    '  no <div class="container-narrow prose"> in the page. The site restructured its legal\n' +
      "  pages; teach scripts/terms-text.mjs the new shape.\n",
  );
  process.exit(1);
}

const diff = firstDifference(expected, actual);
if (!diff) {
  console.log(`  matches src/routes/legal.terms.tsx (${expected.split(" ").length} words)\n`);
  process.exit(0);
}

console.error(`  differs from src/routes/legal.terms.tsx at word ${diff.word}:`);
console.error(`    app:  ...${diff.a}...`);
console.error(`    site: ...${diff.b}...`);
console.error(
  "\n  The app's /legal/terms is canonical. If the app changed, paste the change into the\n" +
    "  HoundStack repo's src/pages/terms.astro; if the site changed on its own, revert it there\n" +
    "  or make the same change here first.\n",
);
process.exit(1);
