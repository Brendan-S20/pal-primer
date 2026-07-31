import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { signOutAndClearDevice } from "@/lib/offline/read-cache";
import { getPlatformContext } from "@/lib/platform.functions";
import { PublicShell } from "@/components/PublicShell";
import { Button } from "@/components/ui/button";
import { Building2 } from "lucide-react";
import { APP_NAME } from "@/lib/scoop";

// BUG-1: an authenticated account that belongs to no organization has no
// tenant context, so every surface under /_authenticated would render an empty
// shell (the repro was /settings/addons showing a blank settings page). The
// route guard now sends those accounts here instead of rendering tenant chrome
// around nothing.
//
// Platform admins never land here — the guard routes them to /platform. This
// page is the honest terminal state for the remaining cases: an account whose
// org was deleted, an invite that was never completed, or a signup that failed
// between account creation and org bootstrap. It deliberately does NOT link to
// /get-started, which starts by creating an account and would collide with the
// session this user already holds.
export const Route = createFileRoute("/no-workspace")({
  ssr: false,
  head: () => ({
    meta: [{ title: `No workspace - ${APP_NAME}` }, { name: "robots", content: "noindex" }],
  }),
  component: NoWorkspacePage,
});

function NoWorkspacePage() {
  const [email, setEmail] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!cancelled) setEmail(data.user?.email ?? null);
      // Belt-and-braces: if someone reaches this page directly while holding
      // platform-admin rights, still offer the console rather than a dead end.
      try {
        const ctx = await getPlatformContext();
        if (!cancelled) setIsPlatformAdmin(!!ctx.isPlatformAdmin);
      } catch {
        /* not an admin, or the check is unavailable — leave the link hidden */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signOut = async () => {
    await signOutAndClearDevice();
    window.location.href = "/auth";
  };

  return (
    <PublicShell tagline="This account isn't attached to a workspace">
      <div className="rounded-lg border bg-card p-6 text-center">
        <Building2 className="mx-auto h-8 w-8 text-muted-foreground" />
        <h1 className="mt-3 text-lg font-semibold">No workspace yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {email ? <strong className="text-foreground">{email}</strong> : "This account"} is signed
          in but isn't a member of any {APP_NAME} workspace, so there's nothing to show. If you were
          invited, open the invitation link again — it attaches your account to the workspace. If
          you think this is a mistake, contact your workspace owner.
        </p>
        <div className="mt-5 flex flex-col gap-2">
          {isPlatformAdmin && (
            <Button asChild>
              <Link to="/platform">Go to the platform console</Link>
            </Button>
          )}
          <Button variant={isPlatformAdmin ? "outline" : "default"} onClick={signOut}>
            Sign out
          </Button>
        </div>
      </div>
    </PublicShell>
  );
}
