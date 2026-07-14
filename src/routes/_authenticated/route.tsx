import { createFileRoute, Link, Outlet, redirect } from "@tanstack/react-router";
import { useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { KeyboardShortcuts } from "@/components/KeyboardShortcuts";
import { OnboardingTour } from "@/components/OnboardingTour";
import { InstallBanner } from "@/components/InstallBanner";
import { AppSidebar } from "@/components/AppSidebar";
import { RoleGuard } from "@/components/RoleGuard";
import { CommandPalette } from "@/components/CommandPalette";
import { NotificationBell } from "@/components/NotificationBell";
import { AnnouncementBanner } from "@/components/AnnouncementBanner";
import { SuspensionBanner } from "@/components/SuspensionBanner";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { HelpCircle, Search } from "lucide-react";
import { useBrandAccent } from "@/hooks/useBrandAccent";

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
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
}

function AppShell() {
  // Native Capacitor bootstrap — matches brand status bar; no-ops on web.
  // Also registers APNs/FCM device tokens with our backend on native platforms.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const native = await import("@/lib/native");
        await native.initStatusBar();
        if (!native.isNative()) return;
        const { subscribeStaffNativePush } = await import("@/lib/push.functions");
        await native.registerPushNotifications(async (token) => {
          if (cancelled) return;
          try {
            await subscribeStaffNativePush({
              data: {
                token,
                platform: native.platform() === "ios" ? "ios" : "android",
                userAgent: navigator.userAgent,
              },
            });
          } catch (e) {
            console.warn("native push register failed", e);
          }
        });
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignOut = async () => {
    await supabase.auth.signOut();
    window.location.href = "/auth";
  };

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

  const brand = useBrandAccent();
  // Scope the tenant brand color to the internal staff app only. Platform-admin
  // routes and the sign-in page live outside this shell and stay HoundStack-branded.
  const brandStyle = brand
    ? ({
        // Primary buttons pick up the tenant brand.
        "--primary": brand.hex,
        "--primary-foreground": brand.fg,
        // Sidebar active-nav highlight — soft brand tint with brand-colored text.
        "--sidebar-accent": brand.soft,
        "--sidebar-accent-foreground": brand.hex,
        // Available for the sidebar logo mark and any future accent spot.
        "--brand-accent": brand.hex,
        "--brand-accent-foreground": brand.fg,
      } as React.CSSProperties)
    : undefined;

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full bg-background" style={brandStyle}>
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
            <Link
              to="/help"
              search={{ article: undefined }}
              aria-label="Knowledge Center"
              className="rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <HelpCircle className="h-4 w-4" />
            </Link>
            <NotificationBell />
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </header>
          <SuspensionBanner />
          <AnnouncementBanner />
          <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 sm:py-8">
            <div className="mx-auto w-full max-w-6xl">
              <Outlet />
            </div>
          </main>
        </div>
        <CommandPalette />
        <KeyboardShortcuts />
        <OnboardingTour />
        <InstallBanner />
        <RoleGuard />
      </div>
    </SidebarProvider>
  );
}
