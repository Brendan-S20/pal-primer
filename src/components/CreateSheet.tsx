import { useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  CalendarClock,
  CalendarPlus,
  FileText,
  Sparkles,
  Upload,
  UserPlus,
  Users,
} from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { canAccess, useMyRole, usePermissions } from "@/hooks/useMyRole";
import { OneOffVisitDialog } from "@/components/OneOffVisitDialog";

/**
 * Mobile quick-create bottom sheet (the ➕ tab).
 *
 * ── Q-4, AND WHAT IT TURNED OUT TO BE ──────────────────────────────────────
 *
 * Only ONE of the original three rows created anything. "New visit" opened the
 * schedule and "New lead" opened the leads board, and both were titled and
 * described as if they created a record. A sheet reached by pressing ➕ that
 * answers with a list view is a small lie told several times a day.
 *
 * They were relabelled rather than removed, because both are genuinely useful
 * shortcuts — they are just shortcuts, and now say so.
 *
 * ── AND THEN IT GREW (2026-08-21) ─────────────────────────────────────────
 *
 * "More functions for the ➕". The fix for the lie above had left the sheet
 * honest but thin: one real create, three rows, on the button a phone user
 * reaches for most. It now carries three creates — client, invoice, import —
 * and three jumps, SPLIT UNDER A HEADING rather than mixed, because the
 * failure this file exists to document is precisely the two being
 * indistinguishable.
 *
 * "New invoice" earns its place in the create half by opening the dialog on
 * arrival (`/invoices?new`), not by dropping you on the invoice list beside a
 * button you then have to find. That is the test for whether a row belongs
 * above the heading or below it.
 *
 * ── A CORRECTION, LEFT IN RATHER THAN QUIETLY DELETED ──────────────────────
 *
 * An earlier version of this header stated that there was NO WAY to create a
 * one-off visit anywhere in the product. That was wrong. It is recorded here
 * because of what happened next: a later research pass over this codebase
 * quoted this very comment back as its evidence for the same claim. A wrong
 * comment does not stay contained — it becomes a source.
 *
 * What is true: Client → Services → Add service → "One time" has existed all
 * along, `service_frequency` carries a `one_time` value, and
 * `generate_visits_core` has a complete branch for it that honours blackout
 * dates, work days and client holds. Verified against the live database.
 *
 * What genuinely did not work was booking one for TODAY: saving a service has
 * never generated its visits (the nightly run does), and the per-service
 * "Generate schedule" button was explicitly disabled for one_time. So the
 * emergency case produced a service with no visit and a banner that read "Its
 * one-time visit is in the past" — which was false. `createOneOffVisit` is
 * that missing path, and the row below is its entry point.
 *
 * Entries are role-filtered with the same canAccess used by routing, so a
 * dispatcher never sees a link the RoleGuard would bounce.
 */
/**
 * CREATES first, then JUMPS, and the two are visually separated below.
 *
 * The ordering is the point. Someone pressing ➕ wants to make something; the
 * shortcuts are useful but they are not why the button exists, and mixing them
 * into one list is how three of the original four rows came to be titled as if
 * they created records when they did not.
 *
 * `search` is how a row stays a CREATE without this file owning a form: the
 * destination opens its own dialog on arrival. /invoices reads `?new` for
 * exactly this (see its `validateSearch`).
 */
const CREATE_ACTIONS = [
  {
    title: "New client",
    description: "Start a client with property, pets, and plan",
    url: "/clients/new",
    search: undefined,
    gate: "/clients/new",
    icon: UserPlus,
    creates: true,
  },
  {
    title: "New invoice",
    description: "Bill a client directly, no visit needed",
    url: "/invoices",
    search: { new: true },
    gate: "/invoices",
    icon: FileText,
    creates: true,
  },
  {
    title: "Import clients",
    description: "Bring a list in from a spreadsheet",
    url: "/imports",
    search: undefined,
    gate: "/imports",
    icon: Upload,
    creates: true,
  },
  {
    title: "Go to the schedule",
    description: "Plan and adjust the day's routes",
    url: "/routes",
    search: undefined,
    gate: "/routes",
    icon: CalendarPlus,
    creates: false,
  },
  {
    title: "Go to leads",
    description: "Review and convert prospects (leads arrive from the website form)",
    url: "/leads",
    search: undefined,
    gate: "/leads",
    icon: Sparkles,
    creates: false,
  },
  {
    title: "Go to your team",
    description: "Invite a teammate, or change who can do what",
    url: "/settings/users",
    search: undefined,
    gate: "/settings/users",
    icon: Users,
    creates: false,
  },
] as const;

export function CreateSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { role } = useMyRole();
  const { can } = usePermissions();
  const actions = CREATE_ACTIONS.filter((a) => canAccess(role, a.gate));
  const creates = actions.filter((a) => a.creates);
  const jumps = actions.filter((a) => !a.creates);
  const [oneOff, setOneOff] = useState(false);
  // Booking a one-off sets a price, so it needs manage_pricing — the same
  // permission createSubscription requires. A dispatcher does not hold it, and
  // showing them a form that throws on submit is the failure this whole pass
  // has been about.
  const canBookOneOff = can("manage_pricing");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="rounded-t-xl p-0 pb-[env(safe-area-inset-bottom)] md:hidden"
      >
        <SheetHeader className="border-b px-4 py-3 text-left">
          {/* "Create" was the fourth place this sheet claimed to create three
              things when it creates one. */}
          <SheetTitle className="text-base">Create &amp; jump to</SheetTitle>
        </SheetHeader>
        {/* `max-h` + `overflow-y-auto` because this list is now long enough to
            pass the bottom of a small phone in landscape, where the viewport is
            ~390pt tall. Without it the last rows are unreachable and there is
            no scrollbar to say so. The safe-area padding stays on the sheet
            itself so the scroll region ends above the home indicator. */}
        <nav
          aria-label="Quick create"
          className="max-h-[70svh] overflow-y-auto overscroll-contain p-2"
        >
          <ul className="space-y-1">
            {creates.map((a) => (
              <li key={a.title}>
                <Link
                  to={a.url}
                  search={a.search as never}
                  onClick={() => onOpenChange(false)}
                  className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted active:bg-muted"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <a.icon className="h-5 w-5" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{a.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {a.description}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
            {canBookOneOff && (
              <li>
                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    setOneOff(true);
                  }}
                  className="flex min-h-14 w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors hover:bg-muted active:bg-muted"
                >
                  <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                    <CalendarClock className="h-5 w-5 shrink-0" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">One-off visit</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      A single visit on a chosen date: call-out, make-up, deep clean
                    </span>
                  </span>
                </button>
              </li>
            )}
          </ul>

          {jumps.length > 0 && (
            <>
              {/* Labelled, rather than just spaced. The whole history of this
                  sheet is rows that looked like creates and were not. */}
              <p className="px-3 pb-1 pt-3 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                Jump to
              </p>
              <ul className="space-y-1">
                {jumps.map((a) => (
                  <li key={a.title}>
                    <Link
                      to={a.url}
                      search={a.search as never}
                      onClick={() => onOpenChange(false)}
                      className="flex min-h-14 items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-muted active:bg-muted"
                    >
                      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <a.icon className="h-5 w-5" />
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm font-medium">{a.title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {a.description}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </>
          )}
        </nav>
      </SheetContent>
      {/* Outside SheetContent: the sheet closes when this opens, and a dialog
          rendered inside a closing sheet unmounts with it. */}
      <OneOffVisitDialog open={oneOff} onOpenChange={setOneOff} />
    </Sheet>
  );
}
