import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMyRole, canAccess } from "@/hooks/useMyRole";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

type Tab = { label: string; to: string; techVisible?: boolean };
type TabGroup = { title: string; tabs: Tab[] };

// Grouped to match the main app sidebar's high-level buckets.
const TAB_GROUPS: TabGroup[] = [
  {
    title: "Business setup",
    tabs: [
      { label: "Preferences", to: "/settings/preferences", techVisible: true },
      { label: "Skip rules", to: "/settings/skip-rules" },
      { label: "Blackouts", to: "/settings/blackouts" },
      { label: "Add-ons", to: "/settings/addons" },
      { label: "Deep-clean", to: "/settings/deep-clean" },
    ],
  },
  {
    title: "Customer-facing",
    tabs: [
      { label: "Lead form", to: "/settings/lead-form" },
      { label: "Promotions", to: "/settings/promotions" },
    ],
  },
  {
    title: "Communications",
    tabs: [
      { label: "SMS", to: "/settings/sms" },
      { label: "Emails", to: "/settings/emails" },
      { label: "AI Tools", to: "/settings/ai" },
      { label: "AI receptionist", to: "/settings/ai-receptionist" },
      { label: "Reviews", to: "/settings/reviews" },
      { label: "Automation", to: "/settings/automation" },
    ],
  },
  {
    title: "Financial",
    tabs: [
      { label: "Billing", to: "/settings/billing" },
      { label: "Accounting", to: "/settings/accounting" },
    ],
  },
  {
    title: "Team",
    tabs: [
      { label: "Users & roles", to: "/settings/users" },
    ],
  },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role } = useMyRole();
  const groups = TAB_GROUPS
    .map((g) => ({
      ...g,
      // Hide tabs the role can't open — showing a link that bounces to the
      // dashboard with "You don't have access" reads as broken (P1.4).
      tabs: g.tabs.filter(
        (t) => (role !== "tech" || t.techVisible) && canAccess(role, t.to),
      ),
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
