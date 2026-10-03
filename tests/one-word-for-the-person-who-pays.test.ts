// The person who pays the business is a CLIENT, on every screen the business
// reads.
//
// ── WHY THIS IS A RULE ────────────────────────────────────────────────────
//
// The launch pass (2026-10, recommendation 14) found staff screens saying
// "client" and, two cards further down the same page, "customer": the sidebar
// says Clients and the re-clean card said "Customers can ask for a free
// re-clean"; the settings rail had a "Client portal" page inside a group called
// "Customer-facing"; the tip switch read "Let customers add a tip" over a
// sentence about "the customer portal" while the page it configures is called
// Client portal. Two words for one person makes a reader wonder whether they
// are two people.
//
// ── WHY "CLIENT" AND NOT "CUSTOMER" ───────────────────────────────────────
//
// It is the word that needed fewer changes. On 2026-10-02 the staff screens
// said "client" about 500 times in their copy and "customer" about 100; the
// database says `clients` (`clients`, `client_id`, `client_portal_*`), and
// every navigation surface already said Clients. Database objects were not
// renamed and are not touched by this.
//
// ── WHAT IS DELIBERATELY NOT IN SCOPE ─────────────────────────────────────
//
//   * Pages the client reads (the portal, the pay link, the quote link,
//     signup, emails to them). They address the reader as "you" and name
//     nobody, so there is no word to make consistent.
//   * "Customer" as another product's word: QuickBooks' import column, the
//     Customer ID columns of Jobber / Housecall Pro / GorillaDesk exports, and
//     Stripe's Customer object. Renaming those would break the import or name
//     a field that does not exist.
//   * A business being HoundStack's customer ("when a business you refer
//     becomes a paying customer"). That is a different relationship, and the
//     one place the other word is right.
//
// ── TO FLIP IT ────────────────────────────────────────────────────────────
//
// If the owner prefers "customer", swap WORD and OTHER below. This test then
// lists every line that says "client" in staff copy, file and line, which is
// the whole of the rename; the nav labels in src/lib/i18n/locales/en.ts and
// AppSidebar come up with it.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/** The word staff screens use for the person who pays the business. */
const WORD = "client";
/** The word they must not use for that person. */
const OTHER = "customer";

const root = join(import.meta.dirname, "..");
const rel = (abs: string) => relative(root, abs).split(sep).join("/");

function walk(dir: string, keep: (p: string) => boolean): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p, keep);
    return keep(rel(p)) ? [p] : [];
  });
}

/** Directories of pages a CLIENT reads, and the marketing site. */
const CLIENT_FACING_DIRS = ["src/components/portal/", "src/components/marketing/", "src/components/signup/"];

/** Server modules whose strings reach a staff screen: notifications, toasts,
 *  report descriptions, the trial banner and the emails sent to the owner. */
const STAFF_COPY_IN_LIB = [
  "src/lib/help-content.ts",
  "src/lib/trial.ts",
  "src/lib/trial-expiry-emails.server.ts",
  "src/lib/cpa-reports.ts",
  "src/lib/cpa-reports.functions.ts",
  "src/lib/disputes.ts",
  "src/lib/disputes.functions.ts",
  "src/lib/quotes.ts",
  "src/lib/quotes.functions.ts",
  "src/lib/one-off-booking.ts",
  "src/lib/platform-inbound.server.ts",
  "src/lib/refunds.server.ts",
  "src/lib/live-tracking.functions.ts",
  "src/lib/imports.functions.ts",
  "src/lib/portal-auth.server.ts",
  "src/lib/i18n/locales/en.ts",
];

const FILES = [
  ...walk(join(root, "src/routes/_authenticated"), (p) => p.endsWith(".tsx")),
  ...walk(
    join(root, "src/components"),
    (p) => p.endsWith(".tsx") && !CLIENT_FACING_DIRS.some((d) => p.startsWith(d)),
  ),
  ...STAFF_COPY_IN_LIB.map((p) => join(root, p)),
];

/** Where the other word is right, each with why. Matched against the text of
 *  the string, so an allowance cannot quietly cover a new sentence. */
const ALLOWED: { file: string; text: RegExp; why: string }[] = [
  {
    file: "src/routes/_authenticated/imports.index.tsx",
    text: /Customer(s| ID)?\b/,
    why: "the column and export names of Sweep&Go, Housecall Pro and GorillaDesk",
  },
  {
    file: "src/lib/imports.functions.ts",
    text: /^customer( name| id)?$/i,
    why: "CSV header aliases that other products write",
  },
  {
    file: "src/lib/cpa-reports.ts",
    text: /^Customer$/,
    why: "QuickBooks' own invoice-import column, which must be spelled its way",
  },
  {
    file: "src/lib/cpa-reports.ts",
    text: /tick the option to add customers that do not exist yet/,
    why: "quotes the label of a QuickBooks import option, which says customers",
  },
  {
    file: "src/lib/help-content.ts",
    text: /becomes a paying customer/,
    why: "a referred BUSINESS becoming HoundStack's customer, a different relationship",
  },
  {
    file: "src/routes/_authenticated/settings.referrals.tsx",
    text: /become a paying customer/,
    why: "a referred BUSINESS becoming HoundStack's customer, a different relationship",
  },
  {
    file: "src/lib/i18n/locales/en.ts",
    text: /./,
    why: "keys are identifiers (customerSaysDoNotEnter); values are checked below",
  },
];

/** Strings that are identifiers rather than copy: an enum value, a query key,
 *  an object key. Copy has a space or a capital in it. */
const IDENTIFIER = /^[a-z0-9_.:/-]+$/;

type Finding = { file: string; line: number; text: string };

function findOther(abs: string): Finding[] {
  const file = rel(abs);
  const source = readFileSync(abs, "utf8");
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const re = new RegExp(`\\b${OTHER}s?\\b`, "i");
  const out: Finding[] = [];
  const visit = (n: ts.Node) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isTypeNode(n)) return;
    let text: string | null = null;
    if (ts.isJsxText(n)) text = n.getText(sf);
    else if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      // An object key is a name, not a sentence.
      const p = n.parent;
      const isKey = p && ts.isPropertyAssignment(p) && p.name === n;
      if (!isKey) text = (n as ts.LiteralLikeNode).text;
    }
    if (text && re.test(text) && !IDENTIFIER.test(text.trim())) {
      out.push({
        file,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        text: text.trim().replace(/\s+/g, " "),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe(`one word for the person who pays: "${WORD}"`, () => {
  it("every file this reads still exists", () => {
    for (const p of [...STAFF_COPY_IN_LIB, ...ALLOWED.map((a) => a.file)]) {
      expect(() => statSync(join(root, p)), p).not.toThrow();
    }
  });

  it(`no staff screen calls them a ${OTHER}`, () => {
    const findings = FILES.flatMap(findOther).filter(
      (f) => !ALLOWED.some((a) => a.file === f.file && a.text.test(f.text)),
    );
    expect(
      findings.map((f) => `${f.file}:${f.line}  ${f.text.slice(0, 110)}`),
      `say "${WORD}" (or swap WORD and OTHER at the top of this file to flip the rule)`,
    ).toEqual([]);
  });

  it("the English strings a technician reads say it too", () => {
    // en.ts is exempted above as a whole because its keys are identifiers;
    // its VALUES are copy, so they are read here on their own.
    const en = readFileSync(join(root, "src/lib/i18n/locales/en.ts"), "utf8");
    const values = [...en.matchAll(/:\s*"([^"]*)"/g)].map((m) => m[1]);
    expect(values.filter((v) => new RegExp(`\\b${OTHER}s?\\b`, "i").test(v))).toEqual([]);
  });

  it("the settings group the client sees is named for them", () => {
    const settings = readFileSync(join(root, "src/routes/_authenticated/settings.tsx"), "utf8");
    expect(settings).toMatch(/title: "Client-facing"/);
    expect(settings).toMatch(/label: "Client portal"/);
  });
});
