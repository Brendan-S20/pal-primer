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
  // The session count on a training stop, and the scores, note and homework
  // a trainer records on it. Both open from My Day and from the visit drawer.
  { file: "src/components/training/TrainingProgressPanel.tsx" },
  // The offline queue's sync toasts ("Synced 3 queued actions", the dead-letter
  // message that names the stop). They moved out of My Day so the queue
  // replays from every page, and they still speak the tech's language.
  { file: "src/components/QueueSync.tsx" },
  // What a technician sees once the owner has turned their access off.
  { file: "src/components/AccessOffCard.tsx" },
  // The stop card's dogs, yard outline, stations and money lines, and the
  // form a tech records cash or a check with.
  { file: "src/components/my-day/StopFacts.tsx" },
  // A groom's pets at the top of the card: handling flags, vaccines on the
  // day, each pet's last grooms and this groom's notes.
  { file: "src/components/my-day/GroomPetPanel.tsx" },
  // Below them: the van's power and water at the address, and the booked
  // add-ons the groomer ticks off (#412).
  { file: "src/components/my-day/GroomVisitExtras.tsx" },
  // A dog walk's card (#410): length and group, how the walker gets in, the
  // minutes out, and the walk report (pee, poo, the note for the client).
  { file: "src/components/my-day/WalkParts.tsx" },
  // A pet sitting visit's card (#411): the stay, the pets and their care,
  // the care log, and the note for the client.
  { file: "src/components/my-day/SitParts.tsx" },
  // The client page a tech opens from a stop's "Client info": gate and
  // lock box codes, hazards and dogs. The office's client page is a different
  // component on the same route and stays in English.
  { file: "src/components/client-detail/FieldClientView.tsx" },
  { file: "src/components/PetSafetyLog.tsx" },
  // (src/components/my-day/RouteLockScreen.tsx left this list on 2026-10-08:
  // its toggle and toasts are gone, and what remains draws nothing. The
  // card's words are built in the tech's language by live-activity-state.ts,
  // which buttons-on-the-lock-screen.test.ts checks in all four.)
  { file: "src/components/CloseOutOpenVisits.tsx" },
  { file: "src/components/EnRouteLocationChip.tsx" },
  // The time clock: its sheet, its row in the More sheet and the sidebar, and
  // the "You're off the clock" reminder on My Day.
  { file: "src/components/TimeClock.tsx" },
  { file: "src/components/VisitChecklistAnswers.tsx" },
  { file: "src/components/PushToggle.tsx" },
  // The line in the shell that says what notifications are for, before the
  // phone's own prompt (R2-35).
  { file: "src/components/NativePushExplainer.tsx" },
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
  { file: "src/components/settings/ThemeCard.tsx" },
  // "Notifications on this phone" on Preferences: the native app's only way
  // to bring up the iOS prompt, or to find the switch after a no.
  { file: "src/components/settings/NativePushCard.tsx" },
  // "Route on the lock screen" on Preferences, beside it.
  { file: "src/components/settings/RouteOnLockScreenCard.tsx" },
  // "Rate HoundStack" at the foot of Preferences, native apps only.
  { file: "src/components/settings/RateAppCard.tsx" },
  { file: "src/routes/_authenticated/my-schedule.tsx" },
  { file: "src/routes/_authenticated/waste-log.tsx" },
  { file: "src/routes/_authenticated/notifications.tsx" },
  { file: "src/components/NotificationPrefs.tsx" },
  { file: "src/components/HelpTip.tsx" },
  { file: "src/components/AddressAutocomplete.tsx" },
  { file: "src/components/LogExpenseSheet.tsx" },
  // In the app header on every page, My Day included. It renders only for a
  // person who can route, and on a one-truck business that is the same
  // person who works My Day.
  { file: "src/components/routes/RoutingRunIndicator.tsx" },
];
