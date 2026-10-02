const en: {
  common: Record<string, string>;
  myDay: Record<string, string>;
  status: Record<string, string>;
  hazards: Record<string, string>;
  photoKinds: Record<string, string>;
  clock: Record<string, string>;
  nav: Record<string, string>;
} = {
  common: {
    loading: "Loading…",
    save: "Save",
    cancel: "Cancel",
    sync: "Sync",
    retry: "Try again",
    offline: "You're offline",
    online: "Back online",
    pending: "{{count}} pending",
    language: "Language",
    english: "English",
    spanish: "Español",
    of: "of",
    done: "done",
  },
  myDay: {
    title: "My day",
    notOnStaff: "Not on any staff record",
    unlinkedStaff: "Your user is not linked to a staff record yet. Ask an owner to add you.",
    nothingScheduled: "Nothing scheduled for you on this day.",
    nextUp: "Next up",
    jump: "Jump",
    inProgress: "In progress",
    resume: "Resume",
    directions: "Directions",
    call: "Call",
    start: "Start",
    complete: "Complete",
    skip: "Skip",
    photo: "Photo",
    before: "Before",
    completion: "Completion",
    issue: "Issue",
    addPhoto: "Add photo",
    skipReason: "Skip reason",
    submit: "Submit",
    dogs: "Dogs",
    hazards: "Safety hazards",
    gateCode: "Gate code",
    lockBox: "Lock box",
    notes: "Notes",
    stations: "Stations",
    addOns: "Add-ons",
    queued: "Queued for sync",
    // Launch pass, 2026-10: the visit card's own controls. Keys above existed
    // for several of these and nothing read them, so a technician who chose
    // Español got "Mi día" over a card that still said Navigate, Start,
    // Complete and, in red capitals, the safety warnings.
    navigate: "Navigate",
    list: "List",
    map: "Map",
    moreOptions: "More options",
    fewerOptions: "Fewer options",
    takePhoto: "Take photo",
    uploading: "Uploading…",
    checklist: "Checklist",
    addNote: "Add a note for the office",
    cantTakePhoto: "Can't take a photo?",
    addOn: "Add-on",
    safetyWarnings: "Safety warnings: read before entering",
    hazardNotes: "Hazard notes:",
  },
  status: {
    scheduled: "scheduled",
    in_progress: "in progress",
    completed: "completed",
    skipped: "skipped",
    canceled: "canceled",
  },
  hazards: {
    do_not_enter_if_dog_out: "DO NOT ENTER if dog is outside",
    aggressive_dog: "Aggressive dog",
    escape_risk: "Escape risk: close gate immediately",
    invisible_fence: "Invisible fence",
    dog_in_yard_during_service: "Dog in yard during service",
    bees_wasps: "Bees / wasps",
    sharp_objects: "Sharp objects",
    slippery_surfaces: "Slippery surfaces",
  },
  photoKinds: {
    before: "Before",
    completion: "Completion",
    gate: "Gate latched",
    issue: "Issue",
  },
  clock: {
    onTheClock: "On the clock · {{duration}}",
    offTheClock: "Off the clock",
    since: "Since {{time}}",
    today: "{{duration}} today",
    clockInPrompt: "Clock in when your day starts",
    clockIn: "Clock in",
    clockOut: "Clock out",
    clockInWaiting: "Clock-in waiting to sync",
    clockOutWaiting: "Clock-out waiting to sync",
  },
  nav: {
    today: "Today",
    wasteLog: "Waste log",
    alerts: "Alerts",
    more: "More",
    home: "Home",
    schedule: "Schedule",
    clients: "Clients",
    create: "Create",
  },
};

export default en;
export type Translations = typeof en;
