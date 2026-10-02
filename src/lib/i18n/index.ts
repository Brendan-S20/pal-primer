import i18n from "i18next";
import { initReactI18next, useTranslation } from "react-i18next";
import en from "./locales/en";
import es from "./locales/es";

const STORAGE_KEY = "scoop.lang";

function detectInitial(): string {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "es") return stored;
    const nav = window.navigator.language?.toLowerCase() ?? "en";
    if (nav.startsWith("es")) return "es";
  } catch {
    // ignore
  }
  return "en";
}

if (!i18n.isInitialized) {
  i18n.use(initReactI18next).init({
    resources: {
      en: { translation: en },
      es: { translation: es },
    },
    lng: detectInitial(),
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
  });
}

export function setLanguage(lang: "en" | "es") {
  i18n.changeLanguage(lang);
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // ignore
  }
}

export function currentLanguage(): "en" | "es" {
  return (i18n.language?.startsWith("es") ? "es" : "en") as "en" | "es";
}

export default i18n;

/**
 * The locale to hand `Intl` for dates and times, from the interface language.
 *
 * `undefined` for English on purpose: before this existed every date on My
 * Day was formatted with the device's own locale, and an English-speaking tech
 * keeps exactly that. Spanish asks for `es-US` — Latin American month and
 * weekday names ("mar, 6 oct") on a US business's 12-hour clock ("2:42 p.m."),
 * which is the clock the office and the customer are reading.
 */
export function intlLocaleFor(lang: string | undefined | null): string | undefined {
  return lang?.startsWith("es") ? "es-US" : undefined;
}

/** `intlLocaleFor` for the language this component is rendering in, so a
 *  language change re-renders the dates along with the words. */
export function useIntlLocale(): string | undefined {
  const { i18n: instance } = useTranslation();
  return intlLocaleFor(instance.language);
}
