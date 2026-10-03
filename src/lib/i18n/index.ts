import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import en from "./locales/en";
import es from "./locales/es";
import ar from "./locales/ar";
import zh from "./locales/zh";

const STORAGE_KEY = "scoop.lang";

/**
 * The interface languages, each named in itself — the picker shows
 * "العربية", not "Arabic", because the person looking for it may not read
 * the language the picker is currently in.
 *
 * `htmlLang` is what goes on <html lang>: `zh-Hans` rather than `zh` so a
 * browser on a Japanese- or Taiwan-configured phone draws Simplified glyphs
 * from a Simplified font, and screen readers pick the right voice.
 */
export const LANGUAGES = [
  { code: "en", nativeName: "English", htmlLang: "en", dir: "ltr" },
  { code: "es", nativeName: "Español", htmlLang: "es", dir: "ltr" },
  { code: "ar", nativeName: "العربية", htmlLang: "ar", dir: "rtl" },
  { code: "zh", nativeName: "中文（简体）", htmlLang: "zh-Hans", dir: "ltr" },
] as const;

export type Language = (typeof LANGUAGES)[number]["code"];

const CODES = new Set<string>(LANGUAGES.map((l) => l.code));

/** The supported language a tag like "es-MX", "ar-EG" or "zh-Hans-CN" means,
 *  or null. Every `zh` maps to Simplified: a Traditional reader reads it far
 *  more easily than English, and Settings → Preferences is one tap away. */
export function languageFor(tag: string | null | undefined): Language | null {
  const base = tag?.toLowerCase().split(/[-_]/)[0] ?? "";
  return CODES.has(base) ? (base as Language) : null;
}

function detectInitial(): Language {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored && CODES.has(stored)) return stored as Language;
    return languageFor(window.navigator.language) ?? "en";
  } catch {
    // ignore
  }
  return "en";
}

/** Right-to-left for Arabic, left-to-right for everything else. */
export function dirFor(lang: string | undefined | null): "ltr" | "rtl" {
  return LANGUAGES.find((l) => l.code === languageFor(lang))?.dir ?? "ltr";
}

/**
 * Puts the language on <html>: `lang` for fonts, hyphenation and screen
 * readers, `dir` so the whole page lays out right-to-left in Arabic. Tailwind's
 * logical utilities (ms-/me-/ps-/pe-/start-/end-/text-start) and its `rtl:`
 * variant both key off this attribute, so it has to be on the root and has to
 * change the moment the language does — not on the next reload.
 *
 * The server always renders `<html lang="en">` (it cannot see localStorage),
 * which is why __root.tsx carries suppressHydrationWarning on that element.
 */
export function applyDocumentLanguage(lang: string | undefined | null) {
  if (typeof document === "undefined") return;
  const entry = LANGUAGES.find((l) => l.code === languageFor(lang)) ?? LANGUAGES[0];
  const root = document.documentElement;
  if (root.getAttribute("lang") !== entry.htmlLang) root.setAttribute("lang", entry.htmlLang);
  if (root.getAttribute("dir") !== entry.dir) root.setAttribute("dir", entry.dir);
}

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      ar: { translation: ar },
      zh: { translation: zh },
    },
    lng: detectInitial(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
  i18n.on("languageChanged", applyDocumentLanguage);
  applyDocumentLanguage(i18n.language);
}

export function setLanguage(lang: Language) {
  i18n.changeLanguage(lang);
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

export function currentLanguage(): Language {
  return languageFor(i18n.language) ?? "en";
}

export default i18n;

/**
 * The locale to hand `Intl` for dates, times and money, from the interface
 * language.
 *
 * `undefined` for English on purpose: before this existed every date on My
 * Day was formatted with the device's own locale, and an English-speaking tech
 * keeps exactly that. Spanish asks for `es-US` — Latin American month and
 * weekday names ("mar, 6 oct") on a US business's 12-hour clock ("2:42 p.m."),
 * which is the clock the office and the customer are reading.
 *
 * Arabic asks for Arabic month and weekday names with WESTERN digits
 * (`-u-nu-latn`): "الثلاثاء، 6 أكتوبر", "2:42 م", "40.00 US$". Arabic-Indic
 * digits (٢:٤٢) are what some Arabic locales default to, and every number a
 * tech reads here is also read by a US office and a US customer — an amount
 * collected, an ETA texted, a time on a timesheet — so it is written in the
 * digits on the invoice. Some engines already default `ar` to Latin digits and
 * some (older Safari) do not, so it is said rather than assumed.
 *
 * Chinese asks for Simplified month and weekday names ("10月6日周二") on a
 * 12-hour clock (`-u-hc-h12`, "下午2:42"): the same reason as Spanish — the
 * office's schedule and the customer's text say 2:42 PM, not 14:42.
 */
export function intlLocaleFor(lang: string | undefined | null): string | undefined {
  switch (languageFor(lang)) {
    case "es":
      return "es-US";
    case "ar":
      return "ar-u-nu-latn";
    case "zh":
      return "zh-Hans-CN-u-hc-h12";
    default:
      return undefined;
  }
}

/** `intlLocaleFor` for the language this component is rendering in, so a
 *  language change re-renders the dates along with the words. */
export function useIntlLocale(): string | undefined {
  const { i18n: instance } = useTranslation();
  return intlLocaleFor(instance.language);
}

