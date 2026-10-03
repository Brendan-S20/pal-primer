import { Link, useRouterState } from "@tanstack/react-router";
import { canAccess, useMyRole } from "@/hooks/useMyRole";

// ── ONE REPORTS AREA, THREE TABS ─────────────────────────────────────────
//
// Reports, Analytics and Tax & accountant were three sidebar entries in two
// groups (Insights and Billing) for one job: looking back at how the business
// did. "Reports" and "Advanced analytics" overlapped, and an owner looking for
// the accountant's pack in January had to know it was filed under Billing
// (launch pass, 2026-10, recommendation 11).
//
// Now the sidebar has one entry, Reports, which stays highlighted on all
// three pages, and each page opens with these tabs. The URLs did not change:
// /reports, /analytics and /tax-reports all still work, bookmarks and the
// links in emails and help articles included, so nothing needed a redirect.
//
// Links rather than a Tabs component, because each tab is a page with its own
// URL, title and data, and the browser's back button should step between them.
// The row scrolls inside itself if it ever outgrows a phone, never the page.

export const REPORT_TABS = [
  { to: "/reports", label: "Overview" },
  { to: "/analytics", label: "Analytics" },
  { to: "/tax-reports", label: "Tax & accountant" },
] as const;

export const REPORT_PATHS: readonly string[] = REPORT_TABS.map((t) => t.to);

export function ReportsNav() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role } = useMyRole();
  const tabs = REPORT_TABS.filter((t) => canAccess(role, t.to));
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Reports" className="-mx-1 overflow-x-auto px-1" data-testid="reports-nav">
      <div className="inline-flex min-w-max items-center gap-1 rounded-lg border bg-muted/40 p-1">
        {tabs.map((t) => {
          const active = pathname === t.to || pathname.startsWith(t.to + "/");
          return (
            <Link
              key={t.to}
              to={t.to}
              aria-current={active ? "page" : undefined}
              className={`inline-flex min-h-9 items-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-colors touch:min-h-11 ${
                active
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
