/**
 * The screens a technician reads in a working day, which therefore speak the
 * language the device is set to (lib/i18n).
 *
 * Shared by tests/a-tech-screen-has-no-english-left-in-it.test.ts, which
 * refuses hardcoded English in them, and tests/en-and-es-have-the-same-keys
 * .test.ts, which checks every key they ask for exists.
 *
 * `only` narrows a file to the named top-level functions, for a file that is
 * half a tech's and half the office's. Settings → Preferences is the one: a
 * tech sees the page itself and the Menus card; the time zone, pricing,
 * commercial-accounts, completion-photo, re-clean and demo cards are drawn
 * for office roles only and are office screens, which stay in English.
 *
 * Adding a screen here is the whole of extending the rule to it.
 */
export const TECH_SCREENS: { file: string; only?: string[] }[] = [
  { file: "src/routes/_authenticated/my-day.tsx" },
  { file: "src/components/CloseOutOpenVisits.tsx" },
  { file: "src/components/EnRouteLocationChip.tsx" },
  { file: "src/components/TimeClockCard.tsx" },
  { file: "src/components/VisitChecklistAnswers.tsx" },
  { file: "src/components/PushToggle.tsx" },
  { file: "src/components/PhotoLightbox.tsx" },
  { file: "src/components/MobileTabBar.tsx" },
  { file: "src/components/AppSidebar.tsx" },
  {
    file: "src/routes/_authenticated/settings.preferences.tsx",
    only: ["PreferencesPage", "AppearanceCard"],
  },
];
