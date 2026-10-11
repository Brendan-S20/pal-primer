// The Terms of Service as plain words, from two places that must agree.
//
// ── ONE DOCUMENT, TWO PAGES ───────────────────────────────────────────────
//
// src/routes/legal.terms.tsx is the canonical Terms (pal-primer#393): it is
// what the App Store and Play listings and the signup flow link to, and the
// one the lawyer reviews. www.houndstack.com/terms, in the HoundStack repo, is
// a word-for-word copy: the app's legal pages are noindex, so the site's page
// is what search engines and the site's own footer point at.
//
// Two repos cannot share a file, so the copy WILL drift. It did: on
// 2026-10-10 the two disagreed on the date, a sentence in the intro and the
// wording of the termination clause, and the issue that found it was the
// lawyer asking which one to read. This module turns each page into the same
// normalised text so check-terms-live.mjs can compare them, and so a test can
// pin the normaliser without a network.
//
// ── WHAT "THE SAME" MEANS HERE ────────────────────────────────────────────
//
// Words, in order, including "Last updated: <date>". NOT markup: the site's
// page links the SMS policy at its own /sms-consent where the app links
// /legal/sms, and Astro compresses whitespace between tags. Every tag becomes
// a space and runs of whitespace collapse, on both sides, so the two agree
// exactly when their prose does. Three things on the site are stripped first
// because the app's LegalShell draws its own: the "Legal" eyebrow, the <h1>,
// and the "This is a copy of ..." line (class `copy-of`), which is the one
// sentence the copy is allowed to add.
//
// The app side is read from SOURCE, not from the live page: the deployed app
// server-renders the <head> and hydrates the body, so a fetch of
// /legal/terms carries no prose, and the host does not deploy on push to main
// anyway (see check-pwa-live.mjs). The source is what the lawyer approved.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENTITIES = {
  "&amp;": "&",
  "&apos;": "'",
  "&#39;": "'",
  "&quot;": '"',
  "&#34;": '"',
  "&ldquo;": "“",
  "&rdquo;": "”",
  "&lsquo;": "‘",
  "&rsquo;": "’",
  "&nbsp;": " ",
};

function decodeEntities(s) {
  return s.replace(/&(?:#\d+|[a-z]+);/gi, (m) => {
    if (m in ENTITIES) return ENTITIES[m];
    const num = /^&#(\d+);$/.exec(m);
    return num ? String.fromCodePoint(Number(num[1])) : m;
  });
}

/** Tags to spaces, entities decoded, whitespace collapsed. The same last step
 *  for both sides, so neither indentation nor minification can make them
 *  differ. */
export function flattenMarkup(markup) {
  return decodeEntities(markup.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/** The app's canonical Terms, from legal.terms.tsx, as one line of text:
 *  "Last updated: <date> <every word of the body>". Throws on a JSX
 *  expression it does not know how to render, because silently dropping one
 *  would compare a sentence with a hole in it and call the pages equal. */
export function canonicalTermsText(repoRoot) {
  const route = readFileSync(join(repoRoot, "src/routes/legal.terms.tsx"), "utf8");
  const appName = /export const APP_NAME = "([^"]+)"/.exec(
    readFileSync(join(repoRoot, "src/lib/scoop.ts"), "utf8"),
  )?.[1];
  if (!appName) throw new Error("APP_NAME not found in src/lib/scoop.ts");

  const updated = /<LegalShell[^>]*\bupdated="([^"]+)"/.exec(route)?.[1];
  if (!updated) throw new Error('legal.terms.tsx: no updated="..." on <LegalShell>');

  const open = route.indexOf("<LegalShell");
  const bodyStart = route.indexOf(">", open) + 1;
  const bodyEnd = route.indexOf("</LegalShell>", bodyStart);
  if (open < 0 || bodyEnd < 0) throw new Error("legal.terms.tsx: no <LegalShell>...</LegalShell>");

  const body = route
    .slice(bodyStart, bodyEnd)
    .replace(/\{APP_NAME\}/g, appName)
    .replace(/\{" "\}/g, " ")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");
  const leftover = /\{[^}]*\}/.exec(body);
  if (leftover) {
    throw new Error(
      `legal.terms.tsx has a JSX expression this checker cannot render: ${leftover[0]}. ` +
        "Teach scripts/terms-text.mjs about it, or write the words out.",
    );
  }
  return `Last updated: ${updated} ${flattenMarkup(body)}`;
}

/** The site's Terms, from the HTML www.houndstack.com/terms serves, reduced
 *  the same way. Null when the page does not have the prose container at all,
 *  which is a different fault (the page is gone or restructured) from a
 *  changed word. */
export function siteTermsText(html) {
  const open = /<div class="container-narrow prose(?:\s[^"]*)?"[^>]*>/.exec(html);
  if (!open) return null;
  const start = open.index + open[0].length;
  const end = html.indexOf("</div>", start);
  if (end < 0) return null;
  const prose = html
    .slice(start, end)
    .replace(/<span class="eyebrow(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/span>/, " ")
    .replace(/<h1[^>]*>[\s\S]*?<\/h1>/, " ")
    .replace(/<p class="muted copy-of(?:\s[^"]*)?"[^>]*>[\s\S]*?<\/p>/, " ");
  return flattenMarkup(prose);
}

/** Where two texts part ways, as words, with a little context on each side.
 *  Null when they are the same. */
export function firstDifference(a, b, context = 6) {
  const wa = a.split(" ");
  const wb = b.split(" ");
  const n = Math.max(wa.length, wb.length);
  for (let i = 0; i < n; i++) {
    if (wa[i] !== wb[i]) {
      const from = Math.max(0, i - context);
      return {
        word: i,
        a: wa.slice(from, i + context + 1).join(" "),
        b: wb.slice(from, i + context + 1).join(" "),
      };
    }
  }
  return null;
}
