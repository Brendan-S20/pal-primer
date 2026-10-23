import { toast } from "sonner";

/** What reassignVisit, rescheduleVisitFromOffice and the bulk moves return
 *  for a timed package lesson that now overlaps another stop of its trainer
 *  (lessonClashes in training-packages.server.ts). */
type LessonClash = { visitId: string; date: string; start: string; end: string };

function shortDay(day: string): string {
  return new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

/**
 * The move has already happened, as booking's "book anyway" lets it. This
 * says which stop it now overlaps, so the office can move one of them. Says
 * nothing when there is no clash, or when the result is from a server that
 * does not report them.
 */
export function warnLessonClashes(result: unknown): void {
  const clashes = (result as { lessonClashes?: LessonClash[] } | null)?.lessonClashes;
  if (!clashes?.length) return;
  const shown = clashes
    .slice(0, 3)
    .map((c) => `${shortDay(c.date)}, ${c.start} to ${c.end}`)
    .join("; ");
  const more = clashes.length > 3 ? ` and ${clashes.length - 3} more` : "";
  toast.warning(
    `The trainer already has a stop at that time: ${shown}${more}. Move one of them if that is wrong.`,
    { duration: 10000 },
  );
}
