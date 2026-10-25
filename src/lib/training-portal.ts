import { packageState, sessionsLeft, type TrainingPackage } from "@/lib/training-packages";

/** The sentence a client reads for each code portal_request_training_lesson
 * raises. The database decides; this only words it. */
export const LESSON_REQUEST_REFUSALS: Record<string, string> = {
  invalid_token: "This portal link is no longer valid. Open the link in your most recent message.",
  package_not_found: "That package is not on your account.",
  property_not_found: "Choose one of your addresses.",
  package_canceled: "This package was canceled. Ask us about a new one.",
  package_expired: "This package has expired. Ask us about a new one.",
  date_too_soon: "Choose a day after today.",
  after_expiry: "Choose a day on or before the day this package expires.",
  date_too_far: "Choose a day within the next 90 days.",
  no_sessions_left:
    "No sessions are left in this package. Lessons already booked or requested use them.",
  coming_soon: "Lesson requests open here soon. Until then, contact us to book your next lesson.",
};

export function lessonRequestRefusal(message: string): string {
  const code = Object.keys(LESSON_REQUEST_REFUSALS).find((c) => message.includes(c));
  return code
    ? LESSON_REQUEST_REFUSALS[code]
    : "That request could not be sent. Please try again, or contact us.";
}

/** Why the portal does not offer "Request a lesson" on a package, or null
 * when it does. Mirrors the refusals in portal_request_training_lesson that
 * do not depend on the day chosen. */
export function lessonRequestBlock(
  pkg: TrainingPackage,
  held: number,
  openRequests: number,
  today: string,
  /** Training is bookable on the platform switch (#531). While it is Coming soon
   *  a held package is shown but takes no requests: the same switch as a
   *  portal purchase, so the launch flip turns both on. */
  bookable = true,
): "package_canceled" | "package_expired" | "no_sessions_left" | "coming_soon" | null {
  const state = packageState(pkg, today);
  if (state === "canceled") return "package_canceled";
  if (state === "expired") return "package_expired";
  if (!bookable) return "coming_soon";
  if (held + openRequests >= pkg.sessions_count) return "no_sessions_left";
  return null;
}

/** The Training page is for a client who already has a package, or whose
 * business runs training and has a package for sale. Nobody else sees it,
 * and it is never a way to ask for training as a new service. */
export function portalShowsTraining(p: {
  hasPackage: boolean;
  runsTraining: boolean;
  forSale: number;
}): boolean {
  return p.hasPackage || (p.runsTraining && p.forSale > 0);
}

export type NoticeKind = "one_left" | "expiring";
export const EXPIRY_NOTICE_DAYS = 14;

/** Whole days from `today` to `day`, both ISO dates on the org's calendar. */
export function daysUntil(today: string, day: string): number {
  return Math.round(
    (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000,
  );
}

/**
 * The notices a package is due today, each with the key that makes it send
 * once. "One left" is keyed by the package: it is told once, when a used
 * session first leaves one. "Expiring" is keyed by the expiry date too, so a
 * package the office extends is told again before its new date.
 */
export function dueNotices(
  pkg: TrainingPackage & { id: string },
  today: string,
): { kind: NoticeKind; key: string }[] {
  if (packageState(pkg, today) !== "active") return [];
  const out: { kind: NoticeKind; key: string }[] = [];
  if (pkg.sessions_used > 0 && sessionsLeft(pkg) === 1)
    out.push({ kind: "one_left", key: `training-one-left:${pkg.id}` });
  if (pkg.expires_on) {
    const days = daysUntil(today, pkg.expires_on);
    if (days >= 0 && days <= EXPIRY_NOTICE_DAYS)
      out.push({ kind: "expiring", key: `training-expiring:${pkg.id}:${pkg.expires_on}` });
  }
  return out;
}

/** What the office reads in the notification centre for a notice. */
export function officeNoticeText(
  kind: NoticeKind,
  p: { clientName: string; packageName: string; left: number; expiresOn: string | null },
): { title: string; body: string } {
  if (kind === "one_left")
    return {
      title: `One session left: ${p.clientName}`,
      body: `${p.packageName} has one session left.`,
    };
  return {
    title: `Training package expiring: ${p.clientName}`,
    body: `${p.packageName} expires on ${p.expiresOn}, with ${p.left} session${p.left === 1 ? "" : "s"} left.`,
  };
}
