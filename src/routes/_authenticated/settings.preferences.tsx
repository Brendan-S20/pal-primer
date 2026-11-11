import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useEffect, useState } from "react";
import { setLanguage, currentLanguage, LANGUAGES, type Language } from "@/lib/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { useMyRole } from "@/hooks/useMyRole";
import { useHeaderPrefs } from "@/hooks/useHeaderPrefs";
import { headerControlsForRole } from "@/lib/header-prefs";
import { ThemeCard } from "@/components/settings/ThemeCard";
import { NativePushCard } from "@/components/settings/NativePushCard";
import { RouteOnLockScreenCard } from "@/components/settings/RouteOnLockScreenCard";
import { RateAppCard } from "@/components/settings/RateAppCard";
import { pageTitle, titleHead, useDocumentTitle } from "@/lib/page-title";

// ── THIS DEVICE, AND NOTHING ELSE ─────────────────────────────────────────
//
// Everything on this page is stored in this browser and changes nothing for
// anyone else: language, light or dark, haptics, keep-awake, the map app and
// the phone menu. The cards that applied to the whole business (time zone,
// standard pricing, commercial accounts, completion photo and checklist,
// re-clean guarantee, demo data) moved to Settings → Business defaults on
// 2026-10-02, so an owner can tell the two kinds apart and a technician never
// scrolls past business rules to reach their language.

export const Route = createFileRoute("/_authenticated/settings/preferences")({
  head: () => titleHead("Preferences", "Settings"),
  component: PreferencesPage,
});

const HAPTICS_KEY = "scoop:haptics";
const MAP_KEY = "scoop:map-app";
const AWAKE_KEY = "scoop:keep-awake";

function getBool(key: string, def: boolean) {
  if (typeof window === "undefined") return def;
  const v = window.localStorage.getItem(key);
  return v == null ? def : v === "1";
}
function setBool(key: string, v: boolean) {
  window.localStorage.setItem(key, v ? "1" : "0");
}
function getStr(key: string, def: string) {
  if (typeof window === "undefined") return def;
  return window.localStorage.getItem(key) ?? def;
}

function PreferencesPage() {
  const { i18n, t } = useTranslation();
  // In the language this device reads. The route's head is English because
  // it runs before i18n has read the device's choice.
  useDocumentTitle(pageTitle(t("preferences.title"), t("settings.title")));
  const [lang, setLang] = useState<string>(currentLanguage());
  const [haptics, setHaptics] = useState(true);
  const [awake, setAwake] = useState(true);
  const [mapApp, setMapApp] = useState("google");

  useEffect(() => {
    setHaptics(getBool(HAPTICS_KEY, true));
    setAwake(getBool(AWAKE_KEY, true));
    setMapApp(getStr(MAP_KEY, "google"));
  }, []);

  return (
    <div className="space-y-6">
      {/* See the note in settings.deep-clean: this page also opened straight
          into a card while the other eighteen led with a heading. */}
      <div>
        <h2 className="text-lg font-semibold">{t("preferences.title")}</h2>
        <p className="text-sm text-muted-foreground">{t("preferences.subtitleDevice")}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t("common.language")}</CardTitle>
          {/* It is per DEVICE (lib/i18n setLanguage writes localStorage).
              This said it applied "across the app, including the tech's My
              Day view", which an owner reads as "my techs get Spanish" and
              a tech reads as being talked about in the third person. */}
          <CardDescription>{t("preferences.languageDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Label htmlFor="lang" className="text-xs">
            {t("preferences.interfaceLanguage")}
          </Label>
          <Select
            value={lang}
            onValueChange={(v) => {
              setLang(v);
              setLanguage(v as Language);
              // Read in the language just chosen, which is the proof it took.
              toast.success(i18n.getFixedT(v)("preferences.languageUpdated"));
            }}
          >
            <SelectTrigger id="lang" className="mt-1 w-56">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {/* Each language in its own name and script, marked as that
                  language, so a screen reader reads "العربية" in Arabic and
                  a tech who cannot read the current language still finds
                  theirs. */}
              {LANGUAGES.map((l) => (
                <SelectItem key={l.code} value={l.code} lang={l.htmlLang} dir={l.dir}>
                  {l.nativeName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("preferences.fieldAppTitle")}</CardTitle>
          <CardDescription>{t("preferences.fieldAppDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <div id="pref-haptics-label" className="text-sm font-medium">
                {t("preferences.haptics")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("preferences.hapticsDescription")}
              </div>
            </div>
            <Switch
              aria-labelledby="pref-haptics-label"
              checked={haptics}
              onCheckedChange={(v) => {
                setHaptics(v);
                setBool(HAPTICS_KEY, v);
              }}
            />
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div id="pref-keep-awake-label" className="text-sm font-medium">
                {t("preferences.keepAwake")}
              </div>
              <div className="text-xs text-muted-foreground">
                {t("preferences.keepAwakeDescription")}
              </div>
            </div>
            <Switch
              aria-labelledby="pref-keep-awake-label"
              checked={awake}
              onCheckedChange={(v) => {
                setAwake(v);
                setBool(AWAKE_KEY, v);
              }}
            />
          </div>
          <div>
            <Label htmlFor="map" className="text-xs">
              {t("preferences.mapApp")}
            </Label>
            <Select
              value={mapApp}
              onValueChange={(v) => {
                setMapApp(v);
                window.localStorage.setItem(MAP_KEY, v);
              }}
            >
              <SelectTrigger id="map" className="mt-1 w-56">
                <SelectValue />
              </SelectTrigger>
              {/* i18n-ignore: product names, the same in every language */}
              <SelectContent>
                <SelectItem value="google">Google Maps</SelectItem>
                <SelectItem value="apple">Apple Maps</SelectItem>
                <SelectItem value="waze">Waze</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      {/* Draws nothing on the web, where PushToggle is the control. */}
      <NativePushCard />
      {/* iPhone app only, beside the notifications it is a cousin of. */}
      <RouteOnLockScreenCard />
      <ThemeCard />
      <AppearanceCard />
      {/* About: iPhone and Android apps only, last so it never sits between
          a person and a setting. */}
      <RateAppCard />
    </div>
  );
}

/** Menus and chrome — the things about how this app LOOKS to one person.
 *
 *  ── WHY THESE MOVED HERE ─────────────────────────────────────────────────
 *
 *  The two top-bar switches lived on /profile, next to the photo, the phone
 *  number and the sign-in email. Those are facts about a PERSON. Which
 *  buttons the chrome shows is a preference, and this page is called
 *  Preferences. Owner's call, 2026-08-25, and it is the right one: nobody
 *  looking for a setting looks under their own name badge.
 *
 *  Saved per person on this device, like the switches always were — see
 *  lib/header-prefs.ts for why that is local rather than a column.
 */
function AppearanceCard() {
  const { prefs, setPref } = useHeaderPrefs();
  const { t } = useTranslation();
  // A technician's header has no Help or Weather button at all, so there is
  // nothing for these switches to switch -- see headerControlsForRole.
  const { role } = useMyRole();
  const roleControls = headerControlsForRole(role);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("preferences.menusTitle")}</CardTitle>
        <CardDescription>{t("preferences.menusDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <Label htmlFor="pref-phone-menu" className="text-xs">
            {t("preferences.phoneMenu")}
          </Label>
          {/* ── ONE MENU, NOT TWO ────────────────────────────────────────
              The tab bar's More button and the top bar's hamburger opened two
              sheets listing the same destinations, in two corners of the same
              screen. Which of them suits you is not something the code can
              know, so it is a choice rather than a guess: a tech working
              one-handed wants the thumb-reachable bar, and somebody used to
              the desktop layout wants the menu where it has always been. */}
          <Select
            value={prefs.phoneNav}
            onValueChange={(v) => setPref("phoneNav", v as "bottom" | "side")}
          >
            <SelectTrigger id="pref-phone-menu" className="mt-1 w-full sm:w-72">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bottom">{t("preferences.phoneMenuBottom")}</SelectItem>
              <SelectItem value="side">{t("preferences.phoneMenuSide")}</SelectItem>
            </SelectContent>
          </Select>
          <p className="pt-1.5 text-xs text-muted-foreground">{t("preferences.phoneMenuNote")}</p>
        </div>

        {(roleControls.help || roleControls.weather) && (
          <div className="space-y-1">
            <Label className="text-xs">{t("preferences.optionalButtons")}</Label>
            <p className="pb-1 text-xs text-muted-foreground">
              {t("preferences.optionalButtonsNote")}
            </p>
            {/* The label wraps the switch so the whole row is the hit area, and
              min-h-11 makes that row legal at every width. A bare switch is a
              ~36px target with an unclickable label beside it. */}
            {roleControls.help && (
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-3">
                <span className="min-w-0 flex-1 text-sm">{t("preferences.knowledgeCenter")}</span>
                <Switch
                  checked={prefs.showHelp}
                  onCheckedChange={(v) => setPref("showHelp", v)}
                  aria-label={t("preferences.knowledgeCenterAria")}
                />
              </label>
            )}
            {roleControls.weather && (
              <label className="flex min-h-11 min-w-0 cursor-pointer items-center justify-between gap-3">
                <span className="min-w-0 flex-1 text-sm">{t("preferences.weather")}</span>
                <Switch
                  checked={prefs.showWeather}
                  onCheckedChange={(v) => setPref("showWeather", v)}
                  aria-label={t("preferences.weatherAria")}
                />
              </label>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
