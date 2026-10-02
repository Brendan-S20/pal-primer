// English and Spanish carry the same keys, with the same placeholders.
//
// ── WHY THIS IS A TEST AND NOT ONLY A TYPE ────────────────────────────────
//
// `es.ts` is typed as `Translations`, the English tree with every leaf widened
// to `string`, so a key missing from Spanish is already a compile error. Three
// things get past that type and each of them is a string a technician reads
// wrong in a driveway:
//
//   * A PLACEHOLDER renamed or dropped. `"{{count}} pendientes"` and
//     `"{{n}} pendientes"` are both strings; the second renders as a literal
//     "{{n}}" on the screen, because i18next leaves an unknown placeholder
//     where it is.
//   * A PLURAL with one side. `_one` without `_other` type-checks — both are
//     ordinary keys to TypeScript — and i18next then falls back to English
//     for every count that is not 1.
//   * A key the CODE asks for that neither file has. i18next answers with the
//     key itself, so the tech sees "visit.navigate" on the button. `t()` takes
//     any string here (there is no module augmentation to narrow it), so this
//     half is checked by reading the call sites.
//
// And an extra Spanish key is not a type error in every position the literal
// check reaches, so both directions are compared here rather than trusting it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import i18next from "i18next";
import en from "../src/lib/i18n/locales/en";
import es from "../src/lib/i18n/locales/es";
import { TECH_SCREENS } from "./support/tech-screens";

const root = join(import.meta.dirname, "..");

type Tree = { [k: string]: string | Tree };

function flatten(tree: Tree, prefix = "", out = new Map<string, string>()) {
  for (const [k, v] of Object.entries(tree)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else flatten(v, key, out);
  }
  return out;
}

const EN = flatten(en as unknown as Tree);
const ES = flatten(es as unknown as Tree);

/** `{{count}}`, `{{ name }}` — i18next's interpolation — and Trans's
 *  `<where/>`, `<strong>`: an element name a translation drops is a client's
 *  name that silently disappears from the sentence. */
const placeholders = (s: string) =>
  [
    ...[...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => `{{${m[1]}}}`),
    ...[...s.matchAll(/<\/?([A-Za-z][\w-]*)\s*\/?>/g)].map((m) => `<${m[1]}>`),
  ].sort();

describe("en and es", () => {
  it("have the same keys, in both directions", () => {
    const onlyEn = [...EN.keys()].filter((k) => !ES.has(k));
    const onlyEs = [...ES.keys()].filter((k) => !EN.has(k));
    expect(onlyEn, "in en.ts and missing from es.ts").toEqual([]);
    expect(onlyEs, "in es.ts and missing from en.ts").toEqual([]);
    // Not vacuous: the tech's day is a few hundred strings.
    expect(EN.size).toBeGreaterThan(250);
  });

  it("use the same placeholders in every string", () => {
    const differs = [...EN.keys()]
      .filter((k) => ES.has(k))
      .filter((k) => placeholders(EN.get(k)!).join() !== placeholders(ES.get(k)!).join())
      .map(
        (k) =>
          `${k}: en ${placeholders(EN.get(k)!).join(" ")} / es ${placeholders(ES.get(k)!).join(" ")}`,
      );
    expect(differs).toEqual([]);
  });

  it("have no empty strings", () => {
    const empty = [...EN, ...ES].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("give every plural both of its sides", () => {
    const incomplete: string[] = [];
    for (const [name, map] of [
      ["en", EN],
      ["es", ES],
    ] as const) {
      for (const k of map.keys()) {
        const m = /^(.*)_(one|other)$/.exec(k);
        if (!m) continue;
        const twin = `${m[1]}_${m[2] === "one" ? "other" : "one"}`;
        if (!map.has(twin)) incomplete.push(`${name}: ${k} has no ${twin}`);
      }
    }
    expect(incomplete).toEqual([]);
  });

  it("resolve plurals and placeholders through i18next the way the app calls them", async () => {
    // The shapes above are only worth checking if i18next reads them the way
    // this file assumes — `_one`/`_other` with `{ count }`, and a plain key
    // when a count is passed to a string with no plural forms.
    const i = i18next.createInstance();
    await i.init({
      resources: { en: { translation: en }, es: { translation: es } },
      lng: "es",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    });
    expect(i.t("sync.synced", { count: 1 })).toBe("Se sincronizó 1 acción en cola");
    expect(i.t("sync.synced", { count: 3 })).toBe("Se sincronizaron 3 acciones en cola");
    expect(i.t("cacheAge.minutes", { count: 12 })).toBe("hace 12 min");
    expect(i.t("clock.visitsCompleted", { count: 1, lng: "en" })).toBe("1 visit completed");
    expect(i.t("clock.visitsCompleted", { count: 2, lng: "en" })).toBe("2 visits completed");
  });
});

describe("a notification type's name", () => {
  // The types a person can mute are listed, with an English label, in
  // notifications-center.functions.ts, and the server hands that list to the
  // settings panel. The panel translates by type code with the label as the
  // fallback, so en.ts carries a second copy of each label. Two copies drift;
  // this keeps them one. Read from source, because importing the module
  // pulls in the server-function runtime.
  const src = readFileSync(join(root, "src/lib/notifications-center.functions.ts"), "utf8");
  const listed = [...src.matchAll(/\{ type: "(\w+)", label: "([^"]+)" \}/g)].map((m) => ({
    type: m[1],
    label: m[2],
  }));

  it("is in en.ts for every type the server lists, with the same English", () => {
    expect(listed.length, "found the NOTIFICATION_TYPES list").toBeGreaterThan(5);
    const mismatched = listed
      .filter(({ type, label }) => EN.get(`notificationType.${type}`) !== label)
      .map(
        ({ type, label }) =>
          `${type}: server says "${label}", en.ts says "${EN.get(`notificationType.${type}`)}"`,
      );
    expect(mismatched).toEqual([]);
  });

  it("names no type the server does not list", () => {
    const types = new Set(listed.map((l) => l.type));
    const stale = [...EN.keys()]
      .filter((k) => k.startsWith("notificationType."))
      .filter((k) => !types.has(k.slice("notificationType.".length)));
    expect(stale).toEqual([]);
  });
});

describe("a sentence with a client's name in it", () => {
  // closeOut.description is the one string rendered through <Trans>, because
  // the name is bold in the middle of it and Spanish puts it somewhere else.
  // Trans PARSES its string for tags. So the name goes in as the element's own
  // child (`<where/>`), never through `{{where}}` — a name somebody typed as
  // "Smith <Rentals>" interpolated first would be parsed as markup and lost.
  it("keeps the name as text, in both languages", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { I18nextProvider, Trans, initReactI18next } = await import("react-i18next");
    const i = i18next.createInstance();
    await i.use(initReactI18next).init({
      resources: { en: { translation: en }, es: { translation: es } },
      lng: "en",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    });
    const render = (lng: string) =>
      renderToStaticMarkup(
        createElement(
          I18nextProvider,
          { i18n: i },
          createElement(Trans, {
            i18nKey: "closeOut.description",
            tOptions: { lng },
            values: { time: "Sat 5:59 PM", day: "Sat, Sep 26" },
            components: { where: createElement("strong", null, "Smith <Rentals>") },
          }),
        ),
      );
    expect(render("en")).toContain(
      "You started <strong>Smith &lt;Rentals&gt;</strong> at Sat 5:59 PM on Sat, Sep 26",
    );
    expect(render("es")).toContain(
      "Empezaste <strong>Smith &lt;Rentals&gt;</strong> el Sat, Sep 26 (Sat 5:59 PM)",
    );
  });
});

describe("every key a tech screen asks for exists", () => {
  // The literal first argument of every t(...) — and of tRef.current(...),
  // i18n.t(...) and the like — in the files the no-English rule covers, plus the
  // modules they share words through. A template-literal key
  // (`status.${visit.status}`) is not checkable here; those all pass an English
  // `defaultValue` or are backed by a fixed code list that has a key per code.
  const EXTRA = [
    "src/lib/offline/useOfflineVisitActions.ts",
    "src/routes/_authenticated/settings.tsx",
  ];
  const TRANSLATORS = /^(t|tRef\.current|i18n\.t|interfaceT)$/;

  const keysAskedFor = () => {
    const found: { file: string; line: number; key: string }[] = [];
    for (const rel of [...TECH_SCREENS.map((s) => s.file), ...EXTRA]) {
      const src = readFileSync(join(root, rel), "utf8");
      const sf = ts.createSourceFile(rel, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (n: ts.Node) => {
        if (ts.isCallExpression(n) && TRANSLATORS.test(n.expression.getText(sf))) {
          const a = n.arguments[0];
          if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) {
            found.push({
              file: rel,
              line: sf.getLineAndCharacterOfPosition(a.getStart(sf)).line + 1,
              key: a.text,
            });
          }
        }
        // <Trans i18nKey="…">
        if (
          ts.isJsxAttribute(n) &&
          n.name.getText(sf) === "i18nKey" &&
          n.initializer &&
          ts.isStringLiteral(n.initializer)
        ) {
          found.push({
            file: rel,
            line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
            key: n.initializer.text,
          });
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    }
    return found;
  };

  const exists = (key: string) => EN.has(key) || EN.has(`${key}_one`) || EN.has(`${key}_other`);

  it("finds the call sites, so a green run means checked", () => {
    expect(keysAskedFor().length).toBeGreaterThan(200);
  });

  it("has an English string for each of them", () => {
    const missing = keysAskedFor()
      .filter((k) => !exists(k.key))
      .map((k) => `${k.file}:${k.line} asks for "${k.key}", which en.ts does not have`);
    expect(missing).toEqual([]);
  });
});
