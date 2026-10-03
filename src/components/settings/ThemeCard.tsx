import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { readThemePref, setThemePref, type ThemePref } from "@/lib/theme";

/** Light, dark, or follow the device. Per device, like the language above:
 *  see src/lib/theme.ts, including why the default is light. */
export function ThemeCard() {
  const { t } = useTranslation();
  const [pref, setPref] = useState<ThemePref>("light");
  useEffect(() => setPref(readThemePref()), []);
  const label: Record<ThemePref, string> = {
    system: t("preferences.themeSystem"),
    light: t("preferences.themeLight"),
    dark: t("preferences.themeDark"),
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("preferences.themeTitle")}</CardTitle>
        <CardDescription>{t("preferences.themeDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* Three buttons rather than a select: three choices fit one row at
            320px, and each is a 44px target on touch. */}
        <div
          role="radiogroup"
          aria-label={t("preferences.themeTitle")}
          className="inline-flex flex-wrap gap-1 rounded-md border bg-card p-0.5"
        >
          {(["system", "light", "dark"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={pref === p}
              data-theme-choice={p}
              onClick={() => {
                setPref(p);
                setThemePref(p);
              }}
              className={`min-h-9 rounded px-3 text-sm touch:min-h-11 ${
                pref === p
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label[p]}
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
