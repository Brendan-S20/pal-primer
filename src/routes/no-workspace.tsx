import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { signOutAndClearDevice } from "@/lib/offline/read-cache";
import { getPlatformContext } from "@/lib/platform.functions";
import { PublicShell } from "@/components/PublicShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ensureBootstrapped } from "@/lib/ensure-workspace";
import { isValidOrgName } from "@/lib/dna-linkage";
import { Building2 } from "lucide-react";
import { APP_NAME } from "@/lib/scoop";
import { pageTitle } from "@/lib/page-title";

// 2026-08-26: this screen now has TWO audiences, and the copy had to stop
// assuming the first. It was written for a stranded account — "there's nothing
// to show", "contact your workspace owner" — and /auth now routes brand-new
// signups here on purpose whenever nothing in the session names the business
// (see NEEDS_ORG_NAME in lib/ensure-workspace.ts). An OAuth round-trip returns
// a profile, never a company, and the old fallback invented
// `${displayName}'s Organization` — a name printed on invoices and the customer
// portal that no settings screen could then change. For that person this page
// is a normal step, not an error, so the wording has to be true for both.
//
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
//
// 2026-08-20: honest, but a dead end — the only action was "Sign out". Signup
// is two calls (registerAccount, then bootstrapOrganization) with no
// transaction around them, so a failure between the two leaves an account that
// owns nothing and cannot retry: /get-started refuses a second registration
// ("That email already has an account"), and nothing here finished the job.
// Nine such accounts exist in production. One signed up on 2026-07-14, came
// back 48 minutes later, and is still stranded — a real business that could not
// reach the product it signed up for.
//
// The recovery below runs ensureBootstrapped, the same sequence /auth runs on
// sign-in, which is what makes it safe to offer: bootstrap_organization takes a
// per-user advisory lock and returns the existing org when user_roles already
// has one, so it cannot mint a second workspace, and the invite is claimed
// BEFORE any org is created. That order is the whole reason this calls the
// shared helper rather than bootstrapOrganization directly — an invited account
// that creates its own org can never accept the invitation afterwards (BUG-18),
// and on this page, where an unfinished invite is one of the three ways to
// arrive, getting that backwards would stand a new trap where the old one was.
export const Route = createFileRoute("/no-workspace")({
  ssr: false,
  // No hydration timer for a client-only route; see _authenticated/route.tsx.
  pendingMinMs: 0,
  head: () => ({
    meta: [{ title: pageTitle("No workspace") }, { name: "robots", content: "noindex" }],
  }),
  component: NoWorkspacePage,
});

function NoWorkspacePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [email, setEmail] = useState<string | null>(null);
  const [isPlatformAdmin, setIsPlatformAdmin] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSubmit = isValidOrgName(orgName) && displayName.trim().length > 0;

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

  const finishSetup = async () => {
    setError(null);
    setBusy(true);
    try {
      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        window.location.href = "/auth";
        return;
      }
      // Returns false when an invitation was claimed instead — that account is
      // now a member of someone else's workspace, so /dashboard is right for
      // both outcomes and the route guard sends them on from there.
      await ensureBootstrapped(data.user, {
        orgName: orgName.trim(),
        displayName: displayName.trim(),
      });

      // ── THE WORKSPACE EXISTS AND THE GUARD CANNOT SEE IT ──────────────
      //
      // _authenticated/route.tsx decides whether you have a workspace with
      // ensureQueryData({ queryKey: ["my-org"], staleTime: 60_000 }), and
      // ensureQueryData answers from cache while the entry is fresh. Landing
      // here populated that cache with "no organization" seconds ago.
      //
      // So without this, the sequence was: create the workspace, navigate to
      // /dashboard, guard reads the stale "no organization", redirect back to
      // /no-workspace -- with `busy` still true, because the navigation was
      // treated as success. The organization was created every time; the app
      // simply could not see it for a minute. Reported as "I enter my business
      // name and it just endlessly loads", which is exactly what it looks like.
      //
      // Removed rather than invalidated: invalidate marks it stale and leaves
      // the value in place, and ensureQueryData is happy to hand a stale value
      // back while the refetch is in flight. Removing forces the guard to ask.
      queryClient.removeQueries({ queryKey: ["my-org"] });
      queryClient.removeQueries({ queryKey: ["platform-context"] });

      navigate({ to: "/dashboard" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't finish setting up. Try again.");
    } finally {
      // ALWAYS. This used to be cleared only on the error path, on the
      // reasoning that success navigates away -- which is true right up until
      // the navigation lands somewhere that sends you back here, and then the
      // spinner never stops and there is no way to try again.
      setBusy(false);
    }
  };

  const signOut = async () => {
    await signOutAndClearDevice();
    window.location.href = "/auth";
  };

  return (
    <PublicShell tagline="One more step to set up your workspace">
      <div className="rounded-lg border bg-card p-(--card-pad) text-center">
        <Building2 className="mx-auto h-8 w-8 text-muted-foreground shrink-0" />
        <h1 className="mt-3 text-lg font-semibold">No workspace yet</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {email ? <strong className="text-foreground">{email}</strong> : "This account"} is signed
          in but isn't part of a {APP_NAME} workspace yet. If you're setting up a new business, fill
          in the form below. If you were invited to someone else's workspace, open the invitation
          link again. It attaches your account to theirs.
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

      {/* Platform admins have no organization by design, so offering to make
          them one would be wrong — bootstrap_organization refuses it anyway. */}
      {!isPlatformAdmin && (
        <form
          className="mt-4 rounded-lg border bg-card p-(--card-pad) text-left"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit && !busy) void finishSetup();
          }}
        >
          <h2 className="text-base font-semibold">Finish setting up your workspace</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell us the business name and we&apos;ll finish creating your workspace, with no new
            account and no second charge. If you were invited to someone else&apos;s workspace
            instead, this joins you to theirs.
          </p>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="nw-org">Business name</Label>
              <Input
                id="nw-org"
                required
                value={orgName}
                onChange={(e) => setOrgName(e.target.value)}
                placeholder="Acme Pet Waste Removal"
              />
              {orgName.trim().length > 0 && !isValidOrgName(orgName) && (
                <p className="text-xs text-destructive">
                  Enter your real business name (not blank or a placeholder like "Test").
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="nw-name">Your name</Label>
              <Input
                id="nw-name"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={!canSubmit || busy}>
              {busy ? "Setting up..." : "Finish setup"}
            </Button>
          </div>
        </form>
      )}
    </PublicShell>
  );
}
