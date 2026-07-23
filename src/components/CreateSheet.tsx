import { Link } from "@tanstack/react-router";
import { CalendarPlus, Sparkles, UserPlus } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { canAccess, useMyRole } from "@/hooks/useMyRole";

/**
 * Mobile quick-create bottom sheet (the ➕ tab). Every entry links to an
 * EXISTING flow — there is no net-new creation surface here:
 * - New client  → /clients/new (full onboarding form)
 * - New visit   → /routes (visits are planned/managed on the schedule; there is
 *   no standalone one-off visit form today)
 * - New lead    → /leads (leads arrive via the public lead form; the board is
 *   the in-app entry point)
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
    title: "New visit",
    description: "Open the schedule to plan or adjust visits",
    url: "/routes",
    gate: "/routes",
    icon: CalendarPlus,
  },
  {
    title: "New lead",
    description: "Review and convert prospects on the leads board",
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
          <SheetTitle className="text-base">Create</SheetTitle>
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
