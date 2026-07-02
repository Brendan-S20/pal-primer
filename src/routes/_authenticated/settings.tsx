import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

const TABS: Array<{ label: string; to: string }> = [
  { label: "Preferences", to: "/settings/preferences" },
  { label: "Skip rules", to: "/settings/skip-rules" },
  { label: "Blackouts", to: "/settings/blackouts" },
  { label: "Add-ons", to: "/settings/addons" },
  { label: "SMS", to: "/settings/sms" },
  { label: "Emails", to: "/settings/emails" },
  { label: "AI receptionist", to: "/settings/ai-receptionist" },
  { label: "Reviews", to: "/settings/reviews" },
  { label: "Automation", to: "/settings/automation" },
  { label: "Accounting", to: "/settings/accounting" },
  { label: "Promotions", to: "/settings/promotions" },
  { label: "Users & roles", to: "/settings/users" },
];


function SettingsLayout() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure how your business runs.</p>
      </div>
      <nav
        aria-label="Settings sections"
        className="-mx-1 flex flex-wrap gap-1 border-b pb-2"
      >
        {TABS.map((tab) => {
          const active = pathname === tab.to || pathname.startsWith(tab.to + "/");
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`rounded-md px-3 py-1.5 text-sm transition-colors ${
                active
                  ? "bg-primary/10 text-primary font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>
      <div>
        <Outlet />
      </div>
    </div>
  );
}
