// A lock box code stays with the walker (#410).
//
// Acceptance: "Lock box code visible to assigned tech + office only, never in
// portal of other clients or logs." Who may READ the row is RLS
// (may_read_property_row), proven in tests/integration/walk-access.db.test.ts.
// This file holds the two places code could carry it further:
//
//   1. The client portal. No portal file selects or returns lock_box_code,
//      gate_code or key_tag, and none selects a property with `*`.
//   2. Logs. No console.*, logActivity or Sentry call anywhere in src/ is
//      handed a lock box code.
//
// Both are read from tokens, not text, so a comment that names the column
// (this repo's comments often do) is not a finding. Each failure names
// file:line.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { repoRelative } from "./support/repo-paths";

const root = join(import.meta.dirname, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}

const ALL = walk(join(root, "src")).map((abs) => ({ abs, rel: repoRelative(abs, root) }));

const isPortalFile = (rel: string) =>
  /^src\/lib\/portal[^/]*\.ts$/.test(rel) ||
  /^src\/routes\/portal\.[^/]*\.tsx?$/.test(rel) ||
  /^src\/components\/portal\//.test(rel);

const SECRET_COLUMN = /\b(lock_box_code|gate_code|key_tag)\b/;
const LOCK_BOX = /lock_?box_?code|lockBoxCode/i;

/** Identifiers and string literals with their line, comments dropped. */
function tokens(file: string, source: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: { text: string; line: number }[] = [];
  const visit = (n: ts.Node) => {
    if (
      ts.isIdentifier(n) ||
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      ts.isTemplateHead(n) ||
      ts.isTemplateMiddle(n) ||
      ts.isTemplateTail(n)
    ) {
      out.push({
        text: ts.isIdentifier(n) ? n.text : (n as ts.LiteralLikeNode).text,
        line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

describe("the client portal", () => {
  const portal = ALL.filter((f) => isPortalFile(f.rel));

  it("is found, so the scan is not vacuous", () => {
    expect(portal.map((f) => f.rel)).toEqual(
      expect.arrayContaining(["src/lib/portal.functions.ts"]),
    );
    expect(portal.length).toBeGreaterThan(5);
  });

  // The one portal file that names the codes is the write-only access path:
  // it writes them and answers "On file" or "Not set". Its replies are pinned
  // to carry no code in tests/a-portal-shows-the-walk-and-never-the-code.test.ts.
  const WRITE_ONLY = "src/lib/portal-access.functions.ts";

  it("never selects or returns a lock box code, gate code or key tag", () => {
    const findings: string[] = [];
    for (const f of portal.filter((x) => x.rel !== WRITE_ONLY)) {
      for (const tok of tokens(f.rel, readFileSync(f.abs, "utf8"))) {
        if (SECRET_COLUMN.test(tok.text)) findings.push(`${f.rel}:${tok.line} ${tok.text}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("never selects a property with *", () => {
    const findings: string[] = [];
    for (const f of portal) {
      for (const tok of tokens(f.rel, readFileSync(f.abs, "utf8"))) {
        if (/properties\s*\(\s*\*\s*\)|^\s*\*\s*$/.test(tok.text))
          findings.push(`${f.rel}:${tok.line} ${JSON.stringify(tok.text)}`);
      }
    }
    expect(findings).toEqual([]);
  });

  it("would catch one (the rule is not dead)", () => {
    const planted = tokens(
      "x.ts",
      'const q = sb.from("properties").select("street, lock_box_code");',
    );
    expect(planted.some((t) => SECRET_COLUMN.test(t.text))).toBe(true);
    const commented = tokens("x.ts", "// lock_box_code is never read here\nconst a = 1;");
    expect(commented.some((t) => SECRET_COLUMN.test(t.text))).toBe(false);
  });
});

describe("logs", () => {
  const LOG_CALL = /^(console\.\w+|logActivity|Sentry\.\w+|captureException|captureMessage)$/;

  function findLogLeaks(file: string, source: string): string[] {
    const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && LOG_CALL.test(n.expression.getText(sf))) {
        for (const a of n.arguments) {
          // Parenthesised, so an object literal parses as one, not a block.
          const argTokens = tokens(file, `(${a.getText(sf)});`);
          if (argTokens.some((t) => LOCK_BOX.test(t.text))) {
            const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
            found.push(`${file}:${line} ${n.expression.getText(sf)}`);
            break;
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    return found;
  }

  it("no console, logActivity or Sentry call is handed a lock box code", () => {
    const findings = ALL.flatMap((f) => findLogLeaks(f.rel, readFileSync(f.abs, "utf8")));
    expect(findings).toEqual([]);
  });

  it("would catch one (the rule is not dead)", () => {
    expect(findLogLeaks("x.ts", 'console.warn("saved", p.lock_box_code);')).toHaveLength(1);
    expect(
      findLogLeaks("x.ts", "await logActivity(sb, { meta: { lockBoxCode: data.lockBoxCode } });"),
    ).toHaveLength(1);
    expect(findLogLeaks("x.ts", 'console.warn("saved", p.street);')).toEqual([]);
  });
});

describe("the calendar", () => {
  it("prints no access code into a feed", () => {
    const feed = readFileSync(join(root, "src/lib/calendar-feed.ts"), "utf8");
    expect(feed).not.toMatch(/`Lock box: \$\{|`Gate code: \$\{|`Key: \$\{/);
  });
});
