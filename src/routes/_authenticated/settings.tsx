import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useMyRole } from "@/hooks/useMyRole";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsLayout,
});

type Tab = { label: string; to: string; techVisible?: boolean };

const TABS: Tab[] = [
  { label: "Preferences", to: "/settings/preferences", techVisible: true },
  { label: "Skip rules", to: "/settings/skip-rules" },
  { label: "Lead form", to: "/settings/lead-form" },
  { label: "Blackouts", to: "/settings/blackouts" },
  { label: "Add-ons", to: "/settings/addons" },
  { label: "SMS", to: "/settings/sms" },
  { label: "Emails", to: "/settings/emails" },
  { label: "AI receptionist", to: "/settings/ai-receptionist" },
  { label: "Reviews", to: "/settings/reviews" },
  { label: "Automation", to: "/settings/automation" },
  { label: "Deep-clean", to: "/settings/deep-clean" },
  { label: "Accounting", to: "/settings/accounting" },
  { label: "Promotions", to: "/settings/promotions" },
  { label: "Users & roles", to: "/settings/users" },
];


function SettingsLayout() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role } = useMyRole();
  const tabs = role === "tech" ? TABS.filter((t) => t.techVisible) : TABS;
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
        {tabs.map((tab) => {
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
