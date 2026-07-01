import { createFileRoute, Outlet, redirect, Link } from "@tanstack/react-router";
import { supabase } from "@/integrations/supabase/client";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AppShell,
});

function AppShell() {
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
          <div className="flex items-center gap-6">
            <Link to="/" className="text-lg font-semibold">
              {APP_NAME}
            </Link>
            <nav className="flex gap-4 text-sm text-muted-foreground">
              <Link to="/" activeOptions={{ exact: true }} activeProps={{ className: "text-foreground font-medium" }}>
                Dashboard
              </Link>
              <Link to="/clients" activeProps={{ className: "text-foreground font-medium" }}>
                Clients
              </Link>
              <Link to="/zones" activeProps={{ className: "text-foreground font-medium" }}>
                Zones
              </Link>
              <Link to="/routes" activeProps={{ className: "text-foreground font-medium" }}>
                Routes
              </Link>
              <Link to="/weather" activeProps={{ className: "text-foreground font-medium" }}>
                Weather
              </Link>
              <Link to="/my-day" activeProps={{ className: "text-foreground font-medium" }}>
                My day
              </Link>
              <Link to="/messages" activeProps={{ className: "text-foreground font-medium" }}>
                Messages
              </Link>
              <Link to="/invoices" activeProps={{ className: "text-foreground font-medium" }}>
                Invoices
              </Link>
              <Link to="/reports" activeProps={{ className: "text-foreground font-medium" }}>
                Reports
              </Link>
              <Link to="/billing" activeProps={{ className: "text-foreground font-medium" }}>
                Billing
              </Link>
              <Link to="/imports" activeProps={{ className: "text-foreground font-medium" }}>
                Import
              </Link>
              <Link to="/settings/skip-rules" activeProps={{ className: "text-foreground font-medium" }}>
                Skip rules
              </Link>
              <Link to="/settings/blackouts" activeProps={{ className: "text-foreground font-medium" }}>
                Blackouts
              </Link>
              <Link to="/settings/sms" activeProps={{ className: "text-foreground font-medium" }}>
                SMS
              </Link>
              <Link to="/settings/automation" activeProps={{ className: "text-foreground font-medium" }}>
                Automation
              </Link>
              <Link to="/settings/emails" activeProps={{ className: "text-foreground font-medium" }}>
                Emails
              </Link>




            </nav>
          </div>
          <button
            onClick={handleSignOut}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
    </div>
  );
}
