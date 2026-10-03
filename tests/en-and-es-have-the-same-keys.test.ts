// Every interface language carries every English key, with the same
// placeholders, and every plural form its language has.
//
// The file is still named for the first two; it covers all of lib/i18n's
// locales — English, Spanish, Arabic and Simplified Chinese — and another is
// one entry in LOCALES below.
//
// ── WHY THIS IS A TEST AND NOT ONLY A TYPE ────────────────────────────────
//
// `es.ts` is typed as `Translations`, and `ar.ts` / `zh.ts` as
// `TranslationsWithPlurals<…>` — the English tree with every leaf widened to
// `string` — so a key missing from a translation is already a compile error.
// Three things get past those types and each of them is a string a technician
// reads wrong in a driveway:
//
//   * A PLACEHOLDER renamed or dropped. `"{{count}} pendientes"` and
//     `"{{n}} pendientes"` are both strings; the second renders as a literal
//     "{{n}}" on the screen, because i18next leaves an unknown placeholder
//     where it is.
//   * A PLURAL missing a form. Every form is an ordinary key to TypeScript,
//     and i18next falls back to ENGLISH for a count whose form is missing — so
//     an Arabic file with `_one` and `_other` and nothing else reads "3 dogs"
//     for three dogs. Arabic chooses between six forms (zero, one, two, few,
//     many, other), Chinese has one, English and Spanish two. Which forms a
//     language has is Intl.PluralRules', checked below against what this file
//     declares, so the list cannot be invented.
//   * A key the CODE asks for that no file has. i18next answers with the
//     key itself, so the tech sees "visit.navigate" on the button. `t()` takes
//     any string here (there is no module augmentation to narrow it), so this
//     half is checked by reading the call sites.
//
// And an extra key is not a type error in every position the literal check
// reaches, so both directions are compared here rather than trusting it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import i18next from "i18next";
import en, { type PluralCategory } from "../src/lib/i18n/locales/en";
import es from "../src/lib/i18n/locales/es";
import ar from "../src/lib/i18n/locales/ar";
import zh from "../src/lib/i18n/locales/zh";
import { formatMoney } from "../src/lib/stop-facts";
import { formatClock } from "../src/lib/format";
import { intlLocaleFor, languageFor, dirFor, LANGUAGES } from "../src/lib/i18n";
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

/**
 * Each translation, and the plural forms it writes for a key English
 * pluralises.
 *
 * Spanish writes `one`/`other` although CLDR also gives it `many`: that form
 * is for exact millions ("1 000 000 de días"), a count nothing on a tech's
 * screen reaches. Every other language writes exactly the forms
 * Intl.PluralRules says it has — asserted below.
 */
const LOCALES: { lng: string; map: Map<string, string>; plurals: PluralCategory[] }[] = [
  { lng: "es", map: flatten(es as unknown as Tree), plurals: ["one", "other"] },
  {
    lng: "ar",
    map: flatten(ar as unknown as Tree),
    plurals: ["zero", "one", "two", "few", "many", "other"],
  },
  { lng: "zh", map: flatten(zh as unknown as Tree), plurals: ["other"] },
];

const PLURAL_KEY = /^(.*)_(zero|one|two|few|many|other)$/;

/** English's pluralised keys, by stem: `cacheAge.days` for `cacheAge.days_one`. */
const STEMS = new Set(
  [...EN.keys()].map((k) => PLURAL_KEY.exec(k)?.[1]).filter((s): s is string => !!s),
);

/** The keys a language with these plural forms has to carry. */
function expectedKeys(plurals: PluralCategory[]) {
  const out = new Set<string>();
  for (const k of EN.keys()) {
    const m = PLURAL_KEY.exec(k);
    if (!m) out.add(k);
    else for (const p of plurals) out.add(`${m[1]}_${p}`);
  }
  return out;
}

/** The forms in which a plural may leave its number out: "كلبان" is "two
 *  dogs" in one word, and "1 perro" is written with its digit. */
const MAY_OMIT_COUNT = new Set(["zero", "one", "two"]);

/** `{{count}}`, `{{ name }}` — i18next's interpolation — and Trans's
 *  `<where/>`, `<strong>`: an element name a translation drops is a client's
 *  name that silently disappears from the sentence. */
const placeholders = (s: string) =>
  [
    ...[...s.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => `{{${m[1]}}}`),
    ...[...s.matchAll(/<\/?([A-Za-z][\w-]*)\s*\/?>/g)].map((m) => `<${m[1]}>`),
  ].sort();

describe("every language", () => {
  it("is offered in the picker under its own name", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(["en", ...LOCALES.map((l) => l.lng)]);
    expect(LANGUAGES.find((l) => l.code === "ar")?.nativeName).toBe("العربية");
    expect(LANGUAGES.find((l) => l.code === "zh")?.nativeName).toBe("中文（简体）");
  });

  for (const { lng, plurals } of LOCALES) {
    it(`${lng} writes exactly the plural forms Intl.PluralRules gives it`, () => {
      const cldr = new Intl.PluralRules(lng).resolvedOptions().pluralCategories as string[];
      // Spanish's `many` is the one documented exception, above LOCALES.
      const expected = lng === "es" ? cldr.filter((c) => c !== "many") : cldr;
      expect([...plurals].sort()).toEqual([...expected].sort());
    });
  }

  for (const { lng, map, plurals } of LOCALES) {
    describe(lng, () => {
      it("has every key English has, and none it does not", () => {
        const want = expectedKeys(plurals);
        const missing = [...want].filter((k) => !map.has(k));
        const extra = [...map.keys()].filter((k) => !want.has(k));
        expect(missing, `in en.ts and missing from ${lng}.ts`).toEqual([]);
        expect(extra, `in ${lng}.ts and not a key en.ts has`).toEqual([]);
        // Not vacuous: the tech's day is a few hundred strings.
        expect(map.size).toBeGreaterThan(250);
      });

      it("uses the same placeholders in every string", () => {
        const differs: string[] = [];
        for (const [k, v] of map) {
          const m = PLURAL_KEY.exec(k);
          const got = placeholders(v);
          if (!m) {
            const want = placeholders(EN.get(k) ?? "");
            if (got.join() !== want.join())
              differs.push(`${k}: en ${want.join(" ")} / ${lng} ${got.join(" ")}`);
            continue;
          }
          // A plural form is compared with English's `_other`, less the
          // number where the form may leave it out — and nothing else may be
          // dropped or added.
          const other = placeholders(EN.get(`${m[1]}_other`) ?? "");
          const omit = (list: string[]) =>
            MAY_OMIT_COUNT.has(m[2]) ? list.filter((p) => p !== "{{count}}") : list;
          if (omit(got).join() !== omit(other).join())
            differs.push(`${k}: en _other ${other.join(" ")} / ${lng} ${got.join(" ")}`);
        }
        expect(differs).toEqual([]);
      });

      it("has no empty strings", () => {
        const empty = [...map].filter(([, v]) => v.trim() === "").map(([k]) => k);
        expect(empty).toEqual([]);
      });
    });
  }

  it("English gives every plural both of its sides", () => {
    const incomplete = [...STEMS].filter((s) => !EN.has(`${s}_one`) || !EN.has(`${s}_other`));
    expect(incomplete).toEqual([]);
    expect(STEMS.size).toBeGreaterThan(8);
    const empty = [...EN].filter(([, v]) => v.trim() === "").map(([k]) => k);
    expect(empty).toEqual([]);
  });

  it("Arabic text never points an arrow backwards", () => {
    // Unicode does not mirror arrows. "Settings → Add-ons" in a right-to-left
    // line points from the add-ons back to Settings.
    const map = LOCALES.find((l) => l.lng === "ar")!.map;
    expect([...map].filter(([, v]) => v.includes("→")).map(([k]) => k)).toEqual([]);
  });

  it("resolve plurals and placeholders through i18next the way the app calls them", async () => {
    // The shapes above are only worth checking if i18next reads them the way
    // this file assumes — a suffix per form with `{ count }`, chosen by the
    // language's own rules, and a plain key when a count is passed to a string
    // with no plural forms.
    const i = i18next.createInstance();
    await i.init({
      resources: {
        en: { translation: en },
        es: { translation: es },
        ar: { translation: ar },
        zh: { translation: zh },
      },
      lng: "es",
      fallbackLng: "en",
      interpolation: { escapeValue: false },
    });
    expect(i.t("sync.synced", { count: 1 })).toBe("Se sincronizó 1 acción en cola");
    expect(i.t("sync.synced", { count: 3 })).toBe("Se sincronizaron 3 acciones en cola");
    expect(i.t("cacheAge.minutes", { count: 12 })).toBe("hace 12 min");
    expect(i.t("clock.visitsCompleted", { count: 1, lng: "en" })).toBe("1 visit completed");
    expect(i.t("clock.visitsCompleted", { count: 2, lng: "en" })).toBe("2 visits completed");

    // Arabic: each of the six forms, at a count that selects it.
    const dogs = (count: number) => i.t("dogs.named", { count, lng: "ar" });
    expect(dogs(0)).toBe("لا كلاب");
    expect(dogs(1)).toBe("كلب واحد");
    expect(dogs(2)).toBe("كلبان");
    expect(dogs(3)).toBe("3 كلاب");
    expect(dogs(11)).toBe("11 كلبًا");
    expect(dogs(100)).toBe("100 كلب");
    // A string English does not pluralise is read as-is with a count.
    expect(i.t("cacheAge.minutes", { count: 12, lng: "ar" })).toBe("منذ 12 د");

    // Chinese: one form, and the number does the work.
    expect(i.t("dogs.named", { count: 1, lng: "zh" })).toBe("1 只狗");
    expect(i.t("dogs.named", { count: 6, lng: "zh" })).toBe("6 只狗");
    expect(i.t("sync.andOthers", { first: "Bark Park", count: 2, lng: "zh" })).toBe(
      "Bark Park及另外 2 处",
    );
  });
});

describe("the language a device asks for", () => {
  it("maps a regional tag to the language", () => {
    expect(languageFor("es-MX")).toBe("es");
    expect(languageFor("ar-EG")).toBe("ar");
    expect(languageFor("zh-CN")).toBe("zh");
    expect(languageFor("zh-Hans-CN")).toBe("zh");
    expect(languageFor("fr-FR")).toBeNull();
    expect(dirFor("ar-SA")).toBe("rtl");
    expect(dirFor("zh")).toBe("ltr");
    expect(dirFor("en")).toBe("ltr");
  });

  it("formats money and times with Western digits in Arabic", () => {
    // The tech reads the same amount the office invoiced and the customer
    // paid. Some engines default Arabic to Arabic-Indic digits (٤٢٫٥٠);
    // lib/i18n asks for `-u-nu-latn` so that none does.
    const arabic = intlLocaleFor("ar");
    const money = formatMoney(4250, arabic);
    expect(money).toMatch(/42\.50/);
    expect(money).not.toMatch(/[٠-٩۰-۹]/);
    const clock = formatClock("14:05:00", arabic);
    expect(clock).toMatch(/2:05/);
    expect(clock).not.toMatch(/[٠-٩۰-۹]/);
  });

  it("puts Chinese times on the 12-hour clock the office reads", () => {
    expect(formatClock("14:05:00", intlLocaleFor("zh"))).toBe("下午2:05");
    expect(formatClock("08:30:00", intlLocaleFor("zh"))).toBe("上午8:30");
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
  it("keeps the name as text, in every language", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { I18nextProvider, Trans, initReactI18next } = await import("react-i18next");
    const i = i18next.createInstance();
    await i.use(initReactI18next).init({
      resources: {
        en: { translation: en },
        es: { translation: es },
        ar: { translation: ar },
        zh: { translation: zh },
      },
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
    expect(render("ar")).toContain("بدأت <strong>Smith &lt;Rentals&gt;</strong> الساعة");
    expect(render("zh")).toContain("开始了<strong>Smith &lt;Rentals&gt;</strong>");
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

  it("has a name for every sidebar entry", () => {
    // AppSidebar names an entry by its URL (`nav.item.<url>`) with the English
    // title as the fallback, so an entry added without a key does not fail the
    // check below -- it shows English in every other language. "Expenses" did,
    // until 2026-10-02.
    const src = readFileSync(join(root, "src/components/AppSidebar.tsx"), "utf8");
    const urls = [...src.matchAll(/url: "\/([^"]+)"/g)].map((m) => m[1]);
    expect(urls.length, "found the sidebar's entries").toBeGreaterThan(10);
    expect(urls.filter((u) => !EN.has(`nav.item.${u}`))).toEqual([]);
  });

  it("has an English string for each of them", () => {
    const missing = keysAskedFor()
      .filter((k) => !exists(k.key))
      .map((k) => `${k.file}:${k.line} asks for "${k.key}", which en.ts does not have`);
    expect(missing).toEqual([]);
  });
});
