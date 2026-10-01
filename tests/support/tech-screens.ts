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
  // The other two tabs on a tech's bar, and the forward view the sidebar and
  // an empty My Day point at. Each with what it draws: the notification
  // settings panel, the "?" beside the waste log's heading, and the address
  // field on its Facilities form. A notification's own title and body are
  // stored server-written text and stay as written; the Knowledge Center
  // article behind the "?" is English-only.
  { file: "src/routes/_authenticated/my-schedule.tsx" },
  { file: "src/routes/_authenticated/waste-log.tsx" },
  { file: "src/routes/_authenticated/notifications.tsx" },
  { file: "src/components/NotificationPrefs.tsx" },
  { file: "src/components/HelpTip.tsx" },
  { file: "src/components/AddressAutocomplete.tsx" },
];
