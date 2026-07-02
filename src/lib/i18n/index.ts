import i18n from "i18next";
import { initReactI18next } from "react-i18next";
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
