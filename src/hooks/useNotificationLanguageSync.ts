import { useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import i18n, { currentLanguage } from "@/lib/i18n";
import { setMyNotificationLanguage } from "@/lib/notifications-center.functions";

const SYNCED_KEY = "scoop.lang.notify";

/**
 * Tell the server which language this person reads, so a push about their
 * own route arrives in it.
 *
 * The interface language is chosen on the device and kept in localStorage
 * (lib/i18n), and a push is written on the server, which cannot read a
 * phone's storage. Without this a tech who reads Spanish got every word of My
 * Day in Spanish and then a lock screen in English.
 *
 * Once per language per signed-in person per device, not on every start: the
 * last value sent is remembered beside the language itself, keyed by user, so
 * a second person signing in on a shared crew phone is sent too. A failed
 * send is simply tried again next start; nothing here can block the app.
 */
export function useNotificationLanguageSync(userId: string | null | undefined) {
  const send = useServerFn(setMyNotificationLanguage);
  useEffect(() => {
    if (!userId) return;
    const key = `${SYNCED_KEY}:${userId}`;
    const sync = () => {
      const language = currentLanguage();
      try {
        if (window.localStorage.getItem(key) === language) return;
      } catch {
        // No storage: send anyway, it is one small request.
      }
      send({ data: { language } })
        .then(() => {
          try {
            window.localStorage.setItem(key, language);
          } catch {
            // ignore
          }
        })
        .catch(() => {
          // Offline, or the column not there yet: next start tries again.
        });
    };
    sync();
    i18n.on("languageChanged", sync);
    return () => {
      i18n.off("languageChanged", sync);
    };
  }, [userId, send]);
}
