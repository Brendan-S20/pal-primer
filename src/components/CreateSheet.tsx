import { Link } from "@tanstack/react-router";
import { CalendarPlus, Sparkles, UserPlus } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { canAccess, useMyRole } from "@/hooks/useMyRole";

/**
 * Mobile quick-create bottom sheet (the ➕ tab).
 *
 * ── Q-4, AND WHAT IT TURNED OUT TO BE ──────────────────────────────────────
 *
 * Only ONE of these three rows creates anything. "New visit" opened the
 * schedule and "New lead" opened the leads board, and both were titled and
 * described as if they created a record. A sheet reached by pressing ➕ that
 * answers with a list view is a small lie told several times a day.
 *
 * They are relabelled rather than removed, because both are genuinely useful
 * shortcuts — they are just shortcuts, and now say so. The first row stays a
 * create because it is one.
 *
 * The real finding underneath Q-4 is not about this sheet: THERE IS NO WAY TO
 * CREATE A ONE-OFF VISIT ANYWHERE IN THE PRODUCT, on any device. Visits exist
 * only as output of generate_visits_through from a subscription. So an
 * emergency call-out, a make-up visit after a skip, or a one-time deep clean
 * cannot be put on the schedule at all. That is a missing capability, not a
 * label problem, and it is left for the owner to schedule — noted in Q-4.
 *
 * Entries are role-filtered with the same canAccess used by routing, so a
 * dispatcher never sees a link the RoleGuard would bounce.
 */
const CREATE_ACTIONS = [
  {
    title: "New client",
    description: "Start a client with property, pets, and plan",
    url: "/clients/new",
    gate: "/clients/new",
    icon: UserPlus,
  },
  {
    title: "Go to the schedule",
    description: "Plan and adjust visits — there is no one-off visit form yet",
    url: "/routes",
    gate: "/routes",
    icon: CalendarPlus,
  },
  {
    title: "Go to leads",
    description: "Review and convert prospects — leads arrive from the website form",
    url: "/leads",
    gate: "/leads",
    icon: Sparkles,
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
  const actions = CREATE_ACTIONS.filter((a) => canAccess(role, a.gate));

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
        <nav aria-label="Quick create" className="p-2">
          <ul className="space-y-1">
            {actions.map((a) => (
              <li key={a.title}>
                <Link
                  to={a.url}
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
          </ul>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
