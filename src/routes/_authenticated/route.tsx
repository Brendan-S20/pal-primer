import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { InstallBanner } from "@/components/InstallBanner";
import { AppSidebar } from "@/components/AppSidebar";
import { RoleGuard } from "@/components/RoleGuard";
import { CommandPalette } from "@/components/CommandPalette";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Search } from "lucide-react";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
    return { user: data.user };
  },
  component: AppShell,
});

function openPalette() {
  window.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }),
  );
}

function AppShell() {
  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  };

  const isMac =
    typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background">
        <AppSidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/80 px-4 backdrop-blur">
            <SidebarTrigger />
            <button
              type="button"
              onClick={openPalette}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md border bg-background/60 px-3 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-muted"
            >
              <Search className="h-4 w-4 shrink-0" />
              <span className="truncate">Search or jump to…</span>
              <kbd className="ml-auto hidden shrink-0 rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px] sm:inline-block">
                {isMac ? "⌘K" : "Ctrl K"}
              </kbd>
            </button>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </header>
          <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
            <div className="mx-auto w-full max-w-6xl">
              <Outlet />
            </div>
          </main>
        </div>
        <CommandPalette />
        <KeyboardShortcuts />
        <InstallBanner />
        <RoleGuard />

      </div>
    </SidebarProvider>
  );
}
