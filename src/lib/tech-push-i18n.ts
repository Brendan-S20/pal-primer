import i18next, { type TFunction } from "i18next";
import en from "@/lib/i18n/locales/en";
import es from "@/lib/i18n/locales/es";
import ar from "@/lib/i18n/locales/ar";
import zh from "@/lib/i18n/locales/zh";

/** The codes this file has words for. lib/i18n is not imported for its own
 *  `languageFor`: loading it initialises the app's React-bound instance as a
 *  side effect, which has no business running inside a server request. The
 *  list is pinned to lib/i18n's LANGUAGES by a test. */
export const PUSH_LANGUAGES = ["en", "es", "ar", "zh"] as const;
type Language = (typeof PUSH_LANGUAGES)[number];

function languageFor(tag: string | null | undefined): Language | null {
  const base = tag?.toLowerCase().split(/[-_]/)[0] ?? "";
  return (PUSH_LANGUAGES as readonly string[]).includes(base) ? (base as Language) : null;
}

/**
 * The words of a push to a technician, on the server, in the tech's language.
 *
 * A push is written where the event happens -- a dispatcher's server
 * function, the office's property form -- and lands on a phone set to
 * Spanish, Arabic or Chinese. The rule in CLAUDE.md ("A tech's screen speaks
 * the tech's language") covers the lock screen too: it is the first screen of
 * the day that says the route changed. So the same locale files the app
 * reads, through the same i18next, with the same plural rules, chosen by the
 * language the person's app last reported (app_notification_prefs.language;
 * useNotificationLanguageSync).
 *
 * Its own instance, not the app's: the app's is bound to the device's
 * language and to React, and a server writes for many people in one request.
 */
let instance: typeof i18next | null = null;

function server() {
  if (instance) return instance;
  const i = i18next.createInstance();
  void i.init({
    resources: {
      en: { translation: en },
      es: { translation: es },
      ar: { translation: ar },
      zh: { translation: zh },
    },
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    returnNull: false,
    // Resources are inline, so there is nothing to wait for: initialise now,
    // not on a later tick, so the first push of a cold start has its words.
    initAsync: false,
  });
  instance = i;
  return i;
}

/** `t` fixed to a language; anything unsupported or unset is English. */
export function techT(language: string | null | undefined): TFunction {
  const lng: Language = languageFor(language) ?? "en";
  return server().getFixedT(lng);
}
