// A technician who picks Español reads Spanish on every screen of the day.
//
// ── WHAT WAS THERE BEFORE ─────────────────────────────────────────────────
//
// lib/i18n had existed for months — i18next, an English and a Spanish file,
// about sixty keys, and a language picker in Settings → Preferences. My Day
// made twelve t() calls. Everything else a tech reads between the first stop
// and the last — the card, the buttons, the skip reasons, the offline banner,
// the toasts, the time clock, the close-out dialog, the tab bar — was English
// written straight into the JSX. So picking Español changed the page heading,
// the progress count and the Next up bar, and left the rest of the day as it
// was. The picker worked; it just had almost nothing to switch.
//
// That is the failure this file is for, and it is not a one-off: the next
// string somebody adds to My Day will be written as `<p>Some words</p>`,
// because that is how a string is written, and a tech whose phone is set to
// Spanish will read one English sentence among Spanish ones.
//
// ── WHAT IT CHECKS ────────────────────────────────────────────────────────
//
// It PARSES the screens rather than grepping them, for the same reason the
// flex-row rule does: the question is about position. `"Start"` is fine as a
// query key, a className, a `kind` in the offline queue or a `defaultValue`
// inside t(); it is a bug as a JSX child, an aria-label or a toast. A grep
// cannot tell those apart and a parser can. What counts as a finding:
//
//   * JSX text containing a letter: `<button>Start</button>`.
//   * A string literal a JSX child expression can render — including both
//     branches of a ternary, the right of `&&`, and the static parts of a
//     template: `{online ? "Couldn't refresh" : "Offline"}`.
//   * The same, as the value of an attribute a person reads or hears:
//     aria-label, title, placeholder, alt, label, tooltip.
//   * The same, as an argument to toast.*(), setError() or a confirm*()
//     dialog, including the values of an options object —
//     `toast.error(..., { description: "..." })`.
//
// A string with no letter in it — "·", "•", "…", "⚠", "+ ", "%" — is not
// language and is not a finding. Nothing inside a call is looked at except
// in the sinks above, so `t("visit.navigate", { defaultValue: "Navigate" })`
// and `new Date().toLocaleDateString(locale, { weekday: "short" })` pass.
//
// ── WHAT IT CANNOT SEE ───────────────────────────────────────────────────
//
// A string that reaches the screen from a variable: a const map of labels, a
// function's return value, a prop a parent passes in. Those were how several
// of these files spelled their labels (HAZARD_LABELS, DOG_TEMPERAMENT_LABELS,
// QUEUED_BADGE_LABELS) and they were converted by hand; a new one would not
// be caught. And a server error's message, which is shown as-is — see the PR.
//
// ── THE ESCAPE ────────────────────────────────────────────────────────────
//
// `// i18n-ignore: <reason>` or `{/* i18n-ignore: <reason> */}` on the line
// of a finding or the line above it, or on the line above a JSX element that
// contains it. For words that are the same in every language — product
// names. The list is pinned below so it cannot grow without somebody writing
// down why.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { TECH_SCREENS } from "./support/tech-screens";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

const HAS_LETTER = /\p{L}/u;

/** Attributes whose value is read or heard by a person. */
const USER_ATTRS = new Set(["aria-label", "title", "placeholder", "alt", "label", "tooltip"]);

/** Calls whose arguments are shown to a person. */
const SINKS = /^(toast(\.\w+)?|setError|confirm\w*)$/;

export type Finding = { file: string; line: number; kind: string; text: string };

/** The string pieces an expression can evaluate to and put on the screen.
 *  Deliberately does not enter calls (t(), toLocaleString, anything else) or
 *  functions, and reads only the value side of comparisons and `&&`. */
function renderedStrings(e: ts.Expression, intoObjects: boolean): ts.Node[] {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return [e];
  if (ts.isTemplateExpression(e)) {
    return [
      e.head,
      ...e.templateSpans.flatMap((s) => [s.literal, ...renderedStrings(s.expression, false)]),
    ];
  }
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e))
    return renderedStrings(e.expression, intoObjects);
  if (ts.isConditionalExpression(e))
    return [
      ...renderedStrings(e.whenTrue, intoObjects),
      ...renderedStrings(e.whenFalse, intoObjects),
    ];
  if (ts.isBinaryExpression(e)) {
    const op = e.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return renderedStrings(e.right, intoObjects);
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken ||
      op === ts.SyntaxKind.PlusToken
    )
      return [...renderedStrings(e.left, intoObjects), ...renderedStrings(e.right, intoObjects)];
    return [];
  }
  if (intoObjects && ts.isObjectLiteralExpression(e)) {
    return e.properties.flatMap((p) =>
      ts.isPropertyAssignment(p) ? renderedStrings(p.initializer, intoObjects) : [],
    );
  }
  return [];
}

const textOf = (n: ts.Node) =>
  ts.isStringLiteral(n) ||
  ts.isNoSubstitutionTemplateLiteral(n) ||
  ts.isTemplateHead(n) ||
  ts.isTemplateMiddle(n) ||
  ts.isTemplateTail(n)
    ? (n as ts.LiteralLikeNode).text
    : n.getText();

export function findEnglish(file: string, source: string, only?: string[]) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split("\n");
  const escapeLines = new Set<number>();
  lines.forEach((l, i) => {
    if (/i18n-ignore\b/.test(l)) escapeLines.add(i + 1);
  });
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

  const escaped = (n: ts.Node): boolean => {
    for (let p: ts.Node | undefined = n; p; p = p.parent) {
      const isStart =
        p === n || ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p) || ts.isJsxFragment(p);
      if (!isStart) continue;
      const l = lineOf(p);
      if (escapeLines.has(l) || escapeLines.has(l - 1)) return true;
    }
    return false;
  };

  const findings: Finding[] = [];
  let scanned = 0;
  const report = (n: ts.Node, kind: string) => {
    const text = textOf(n).trim();
    if (!HAS_LETTER.test(text) || escaped(n)) return;
    findings.push({ file, line: lineOf(n), kind, text });
  };

  const visit = (n: ts.Node) => {
    if (ts.isJsxText(n)) {
      scanned += 1;
      report(n, "JSX text");
    } else if (ts.isJsxExpression(n) && n.expression && !ts.isJsxAttribute(n.parent)) {
      scanned += 1;
      for (const s of renderedStrings(n.expression, false)) report(s, "rendered string");
    } else if (ts.isJsxAttribute(n) && USER_ATTRS.has(n.name.getText(sf)) && n.initializer) {
      scanned += 1;
      const name = n.name.getText(sf);
      if (ts.isStringLiteral(n.initializer)) report(n.initializer, name);
      else if (ts.isJsxExpression(n.initializer) && n.initializer.expression)
        for (const s of renderedStrings(n.initializer.expression, false)) report(s, name);
    } else if (ts.isCallExpression(n) && SINKS.test(n.expression.getText(sf))) {
      scanned += 1;
      const callee = n.expression.getText(sf);
      for (const a of n.arguments)
        for (const s of renderedStrings(a, true)) report(s, `${callee}()`);
    }
    ts.forEachChild(n, visit);
  };

  if (only) {
    const roots = sf.statements.filter(
      (s): s is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(s) && !!s.name && only.includes(s.name.text),
    );
    // A renamed component would otherwise leave this file checking nothing.
    if (roots.length !== only.length)
      throw new Error(
        `${file}: expected functions ${only.join(", ")}, found ${roots.map((r) => r.name?.text).join(", ")}`,
      );
    roots.forEach(visit);
  } else {
    visit(sf);
  }
  return { findings, scanned, escapes: [...escapeLines].map((l) => `${file}:${l}`) };
}

const scanAll = () =>
  TECH_SCREENS.map((s) => ({ ...s, ...findEnglish(s.file, read(s.file), s.only) }));

const describeFinding = (f: Finding) => `${f.file}:${f.line} (${f.kind}) ${JSON.stringify(f.text)}`;

describe("the screens a technician reads have no English written into them", () => {
  it("scans every screen on the list, and each has something to scan", () => {
    // A file that parses to nothing — a rename, an `only` that no longer
    // matches — would pass the next test for free.
    for (const s of scanAll()) expect(s.scanned, s.file).toBeGreaterThan(5);
    expect(scanAll().reduce((n, s) => n + s.scanned, 0)).toBeGreaterThan(400);
  });

  it("puts every word a tech reads through t()", () => {
    const found = scanAll().flatMap((s) => s.findings.map(describeFinding));
    // Named, not counted: file and line, and the English that is there.
    expect(found).toEqual([]);
  });

  it("keeps the escape hatch to the product names it was made for", () => {
    const escapes = scanAll().flatMap((s) => s.escapes);
    // Pinned by position, so growing the list is an edit to this file and a
    // sentence about why. Google Maps, Apple Maps and Waze: the names of the
    // apps the Directions button can open, which are what those apps are
    // called in Spanish too.
    expect(escapes.map((e) => e.replace(/:\d+$/, ""))).toEqual([
      "src/routes/_authenticated/settings.preferences.tsx",
    ]);
  });
});

describe("the rule fires on what it is for, and not on what it is not", () => {
  const probe = (body: string) =>
    findEnglish("probe.tsx", `export function P() { return (${body}); }`).findings.map(
      (f) => `${f.kind}: ${f.text}`,
    );

  it("catches JSX text", () => {
    expect(probe(`<button>Start</button>`)).toEqual(["JSX text: Start"]);
  });

  it("catches both branches of a ternary, the right of &&, and a template's words", () => {
    expect(probe(`<p>{online ? "Couldn't refresh" : "Offline"}</p>`)).toEqual([
      "rendered string: Couldn't refresh",
      "rendered string: Offline",
    ]);
    expect(probe(`<p>{done && "Skipped"}</p>`)).toEqual(["rendered string: Skipped"]);
    expect(probe("<p>{`${n} queued`}</p>")).toEqual(["rendered string: queued"]);
  });

  it("catches the attributes a person reads or hears", () => {
    expect(probe(`<input aria-label="Pick a day" placeholder={a ? "Notes" : "Where"} />`)).toEqual([
      "aria-label: Pick a day",
      "placeholder: Notes",
      "placeholder: Where",
    ]);
    expect(probe(`<img alt="Visit" title={\`Open \${x}\`} />`)).toEqual([
      "alt: Visit",
      "title: Open",
    ]);
  });

  it("catches a toast, its description, and the dialog sinks", () => {
    expect(
      probe(
        `<button onClick={() => toast.error("Sync stalled", { description: "Retry later", duration: 5 })} />`,
      ),
    ).toEqual(["toast.error(): Sync stalled", "toast.error(): Retry later"]);
    expect(probe(`<b onClick={() => setError("That time isn't valid.")} />`)).toEqual([
      "setError(): That time isn't valid.",
    ]);
  });

  it("passes words that go through t(), and strings that are not words on a screen", () => {
    expect(
      probe(`<div className="flex min-w-0 items-center" data-state="open" aria-hidden="true">
        {t("visit.navigate", { defaultValue: "Navigate" })} · {n}% …
        <input type="date" aria-label={t("myDay.pickADay")} />
        {new Date().toLocaleDateString(locale, { weekday: "short" })}
        <button onClick={() => toast.success(t("visit.started"))}>+ {t("visit.addOn")}</button>
      </div>`),
    ).toEqual([]);
  });

  it("honours the escape, on the line or on the element above", () => {
    expect(
      probe(`<div>
        {/* i18n-ignore: product names */}
        <select>
          <option>Google Maps</option>
          <option>Waze</option>
        </select>
        <p>Not escaped</p>
      </div>`),
    ).toEqual(["JSX text: Not escaped"]);
  });

  it("fails on the real My Day when one hardcoded string goes back in", () => {
    // Mutation-tested against the file as it ships, not a reconstruction: put
    // back the English the Navigate button had before this change and the
    // rule has to name that line.
    const file = "src/routes/_authenticated/my-day.tsx";
    const real = read(file);
    const needle = `{t("visit.navigate")}`;
    expect(real).toContain(needle);
    const mutated = real.replace(needle, "Navigate");
    const line = mutated.slice(0, mutated.indexOf("Navigate\n")).split("\n").length;
    expect(findEnglish(file, real).findings).toEqual([]);
    expect(findEnglish(file, mutated).findings.map(describeFinding)).toEqual([
      `${file}:${line} (JSX text) "Navigate"`,
    ]);

    // And a toast, which is the other shape a new string arrives in.
    const toastNeedle = `toast.success(t("visit.smsSent"))`;
    expect(real).toContain(toastNeedle);
    const toasted = real.replace(toastNeedle, `toast.success("SMS sent")`);
    expect(findEnglish(file, toasted).findings.map((f) => f.text)).toEqual(["SMS sent"]);
  });

  it("fails on the real waste log and alerts page when their English goes back in", () => {
    // The two other tabs on a tech's bar, added to the list after My Day. The
    // same mutation, against the files as they ship: the waste log's
    // " · No facility recorded" fallback was a string in a ternary, and the
    // alerts page's delete button was a literal aria-label.
    const waste = "src/routes/_authenticated/waste-log.tsx";
    const realWaste = read(waste);
    const needle = `{m.waste_disposal_facilities?.name || t("wasteLog.noFacility")}`;
    expect(realWaste).toContain(needle);
    const mutated = realWaste.replace(
      needle,
      `{m.waste_disposal_facilities?.name || "No facility recorded"}`,
    );
    const line = mutated.slice(0, mutated.indexOf(`"No facility recorded"`)).split("\n").length;
    expect(findEnglish(waste, realWaste).findings).toEqual([]);
    expect(findEnglish(waste, mutated).findings.map(describeFinding)).toEqual([
      `${waste}:${line} (rendered string) "No facility recorded"`,
    ]);

    const alerts = "src/routes/_authenticated/notifications.tsx";
    const realAlerts = read(alerts);
    const label = `aria-label={t("alerts.delete")}`;
    expect(realAlerts).toContain(label);
    const unlabelled = realAlerts.replace(label, `aria-label="Delete notification"`);
    expect(findEnglish(alerts, unlabelled).findings.map((f) => `${f.kind}: ${f.text}`)).toEqual([
      "aria-label: Delete notification",
    ]);
  });
});
