import i18n from "@/lib/i18n";
import { useTranslation } from "react-i18next";
import en from "@/lib/i18n/locales/en";

const keys = new Map<string, string>(
  Object.entries(en.launch).map(([key, value]) => [value, `launch.${key}`]),
);

/** Translate launch copy where the existing screen still uses English source text. */
export function launchCopy(source: string): string {
  const key = keys.get(source);
  return key ? String(i18n.t(key, { defaultValue: source })) : source;
}

export function useLaunchCopy() {
  useTranslation();
  return launchCopy;
}
