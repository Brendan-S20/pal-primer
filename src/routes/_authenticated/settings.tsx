import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMyRole } from "@/hooks/useMyRole";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

type Tab = { label: string; to: string; techVisible?: boolean };
type TabGroup = { title: string; tabs: Tab[] };

// Grouped like the main sidebar (punch list #8) — sixteen flat chips made
// QuickBooks/Xero (and everything else) hard to find.
const TAB_GROUPS: TabGroup[] = [
  {
    title: "Business",
    tabs: [
      { label: "Preferences", to: "/settings/preferences", techVisible: true },
      { label: "Users & roles", to: "/settings/users" },
    ],
  },
  {
    title: "Scheduling",
    tabs: [
      { label: "Skip rules", to: "/settings/skip-rules" },
      { label: "Blackouts", to: "/settings/blackouts" },
      { label: "Automation", to: "/settings/automation" },
      { label: "Deep-clean", to: "/settings/deep-clean" },
    ],
  },
  {
    title: "Sales & marketing",
    tabs: [
      { label: "Lead form", to: "/settings/lead-form" },
      { label: "Add-ons", to: "/settings/addons" },
      { label: "Promotions", to: "/settings/promotions" },
      { label: "Reviews", to: "/settings/reviews" },
    ],
  },
  {
    title: "Communications",
    tabs: [
      { label: "SMS", to: "/settings/sms" },
      { label: "Emails", to: "/settings/emails" },
    ],
  },
  {
    title: "AI",
    tabs: [
      { label: "AI Tools", to: "/settings/ai" },
      { label: "AI receptionist", to: "/settings/ai-receptionist" },
    ],
  },
  {
    title: "Billing & accounting",
    tabs: [
      { label: "Plan & billing", to: "/settings/billing" },
      { label: "Accounting", to: "/settings/accounting" },
    ],
  },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role } = useMyRole();
  const groups = TAB_GROUPS
    .map((g) => ({
      ...g,
      tabs: role === "tech" ? g.tabs.filter((t) => t.techVisible) : g.tabs,
    }))
    .filter((g) => g.tabs.length > 0);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure how your business runs.</p>
      </div>
      <nav aria-label="Settings sections" className="space-y-2 border-b pb-3">
        {groups.map((group) => (
          <div key={group.title} className="flex flex-wrap items-baseline gap-1">
            <span className="w-36 shrink-0 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {group.title}
            </span>
            {group.tabs.map((tab) => {
              const active = pathname === tab.to || pathname.startsWith(tab.to + "/");
              return (
                <Link
                  key={tab.to}
                  to={tab.to}
                  className={`rounded-md px-3 py-1 text-sm transition-colors ${
                    active
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div>
        <Outlet />
      </div>
    </div>
  );
}
