import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { listMyNotifications } from "@/lib/notifications-center.functions";

/**
 * The header bell: a LINK to /notifications, not a dropdown.
 *
 * ── WHY IT STOPPED BEING AN OVERLAY ───────────────────────────────────────
 *
 * It used to open a 320px panel anchored to the header, with a nested
 * settings sub-panel behind a gear icon, a "View all" link to the very page
 * this now goes to, and its own scroll container. Three problems, and the
 * phone made all three worse:
 *
 *   * Below `md` the panel already had to abandon its own design and pin to
 *     the viewport edges (`max-md:fixed max-md:inset-x-3 max-md:top-16`),
 *     because a fixed `w-80` box overflows a 360px screen. At that point it
 *     was a full-screen sheet pretending to be a popover.
 *   * It duplicated /notifications — the same list, the same mark-read, the
 *     same delete, written twice and able to drift.
 *   * Its content sat under `max-h-96 overflow-y-auto` INSIDE a page that
 *     also scrolls, which is the nested-scroll trap this codebase's own rules
 *     warn about.
 *
 * The page does all of it with more room, is linkable, survives a reload, and
 * is where a push notification's deep link already lands. So the bell's job is
 * now just the two things a header control should do: show whether anything is
 * waiting, and take you to it.
 *
 * The unread COUNT still lives here, because that is what the badge needs.
 */
export function NotificationBell() {
  const listFn = useServerFn(listMyNotifications);
  const q = useQuery({
    queryKey: ["notifications"],
    queryFn: () => listFn(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const unread: number = (q.data as any)?.unread ?? 0;

  return (
    <Link
      to="/notifications"
      aria-label={unread > 0 ? `Alerts, ${unread} unread` : "Alerts"}
      // A 16px glyph centred in a 44px box, the shape ui/dialog.tsx and
      // ui/sheet.tsx already use. Padding was carrying the size here — `p-2`
      // is a 32px target and `touch:p-2.5` around a 20px glyph reaches 40,
      // so this was under the minimum on every width, phone included.
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      {/* The unread count is anchored to the GLYPH rather than to the hit
          area. Pinned to the link's corner it would sit out in the empty
          padding of the 44px box, reading as a badge floating beside the
          bell instead of on it. */}
      <span className="relative flex items-center justify-center">
        <Bell className="h-4 w-4 max-md:h-5 max-md:w-5" />
        {unread > 0 && (
          <span className="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-3xs font-semibold leading-none text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </span>
    </Link>
  );
}
