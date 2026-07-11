import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { lovable } from "@/integrations/lovable/index";
import { bootstrapOrganization } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/scoop";
import { Logo } from "@/components/Logo";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: `Sign in — ${APP_NAME}` },
      { name: "description", content: `Sign in to ${APP_NAME}.` },
    ],
  }),
  component: AuthPage,
});

// If the user has no org membership yet (email-confirmation flow: bootstrap was
// deferred from signup), create the org + owner role now using the metadata
// captured at signup. Idempotent server-side via bootstrap_organization().
/** Returns true when a brand-new org was just bootstrapped — that caller
 *  should route to /onboarding instead of the usual landing page. */
async function ensureBootstrapped(user: { id: string; email?: string | null; user_metadata?: Record<string, any> | null }): Promise<boolean> {
  const { data: existing } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing) return false;

  // Platform admins have zero user_roles rows by design — they must never get
  // a tenant org auto-provisioned. (bootstrap_organization also guards this
  // server-side; the check here avoids a pointless org-create round trip.)
  const { data: isPlatform } = await supabase.rpc("is_platform_admin", { _user_id: user.id });
  if (isPlatform) return false;

  // Teammate invite (finding #40): if this email was invited to an existing
  // org, join THAT org with the invited role instead of bootstrapping a new
  // one. Idempotent server-side; returns null when there's no pending invite.
  const { data: invitedOrg } = await supabase.rpc("accept_org_invite_for_current_user" as any);
  if (invitedOrg) {
    // A new employee just joined — reconcile the org's Stripe seat count so
    // per-employee billing catches up immediately. Best-effort.
    try {
      const { resyncMySeats } = await import("@/lib/users.functions");
      await resyncMySeats();
    } catch (err) {
      console.error("seat resync after invite acceptance failed", err);
    }
    return false;
  }

  const md = user.user_metadata ?? {};
  const emailLocal = (user.email ?? "").split("@")[0] || "Owner";
  const displayName: string =
    (typeof md.display_name === "string" && md.display_name.trim()) ||
    (typeof md.full_name === "string" && md.full_name.trim()) ||
    (typeof md.name === "string" && md.name.trim()) ||
    emailLocal;
  const orgName: string =
    (typeof md.org_name === "string" && md.org_name.trim()) ||
    `${displayName}'s Organization`;

  await bootstrapOrganization({ data: { orgName, displayName } });
  // Get-started walkthrough stashes texting consent in user metadata when the
  // email-confirmation flow defers bootstrap — apply it now (best-effort).
  if (md.sms_consent === true && typeof md.phone === "string" && md.phone.trim()) {
    try {
      const { recordSmsConsent } = await import("@/lib/org.functions");
      const { SMS_CONSENT_TEXT } = await import("@/routes/get-started");
      await recordSmsConsent({ data: { phone: md.phone.trim(), consentText: SMS_CONSENT_TEXT } });
    } catch (err) {
      console.error("deferred sms consent record failed", err);
    }
  }
  return true;
}

// Where a given role should land immediately after sign-in.
async function landingPathForUser(userId: string): Promise<string> {
  // Platform admins always land in the platform console — never inside a tenant
  // dashboard (impersonation uses a separate magic-link session for that).
  const { data: isPlatform } = await supabase.rpc("is_platform_admin", { _user_id: userId });
  if (isPlatform) return "/platform";

  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .maybeSingle();
  const role = data?.role;
  if (role === "tech") return "/my-day";
  if (role === "dispatcher") return "/routes";
  if (role === "owner" || role === "office_manager") return "/dashboard";
  // No role yet (fresh signup) → dashboard triggers onboarding.
  return "/dashboard";
}

function AuthPage() {
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // If already signed in, ensure org bootstrap (deferred from signup) then land.
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      try {
        await ensureBootstrapped(data.user as any);
      } catch (err) {
        console.error("bootstrap on landing failed", err);
      }
      const to = await landingPathForUser(data.user.id);
      navigate({ to });
    });
  }, [navigate]);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setLoading(false);
      return setError(error.message);
    }
    let isNewOrg = false;
    if (data.user) {
      try {
        isNewOrg = await ensureBootstrapped(data.user as any);
      } catch (err) {
        setLoading(false);
        return setError(err instanceof Error ? err.message : "Failed to create organization");
      }
    }
    setLoading(false);
    const to = isNewOrg ? "/onboarding" : data.user ? await landingPathForUser(data.user.id) : "/dashboard";
    navigate({ to });
  };


  const oauthSignIn = async (provider: "google" | "apple" | "facebook") => {
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    setError(null);
    setLoading(true);
    try {
      if (provider === "facebook") {
        // Not in the cloud-auth wrapper — use the Supabase provider directly.
        // Always a full redirect; errors surface before navigation.
        const { error: fbErr } = await supabase.auth.signInWithOAuth({
          provider: "facebook",
          options: { redirectTo: window.location.origin },
        });
        if (fbErr) {
          setLoading(false);
          return setError(fbErr.message ?? `${label} sign-in failed`);
        }
        return; // browser will redirect
      }
      const result = await lovable.auth.signInWithOAuth(provider, {
        redirect_uri: window.location.origin,
      });
      if (result.error) {
        setLoading(false);
        return setError(result.error.message ?? `${label} sign-in failed`);
      }
      if (result.redirected) return; // browser will redirect
      // Popup flow completed with session → bootstrap if needed, then role-aware landing.
      const { data } = await supabase.auth.getUser();
      let isNewOrg = false;
      if (data.user) {
        try {
          isNewOrg = await ensureBootstrapped(data.user as any);
        } catch (err) {
          setLoading(false);
          return setError(err instanceof Error ? err.message : "Failed to create organization");
        }
      }
      const to = isNewOrg ? "/onboarding" : data.user ? await landingPathForUser(data.user.id) : "/dashboard";
      navigate({ to });
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : `${label} sign-in failed`);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-md space-y-6">
        <div className="flex flex-col items-center text-center">
          <Logo variant="logo" className="h-14 w-auto text-primary" />
          <p className="mt-3 text-sm text-muted-foreground">{APP_DESCRIPTION}</p>
        </div>

        <div className="space-y-3 rounded-lg border bg-card p-4">
          {/* Punch list #19: Apple and Facebook alongside Google. Google and
              Apple ride the cloud-auth wrapper; Facebook goes through the
              Supabase provider directly (not in the wrapper). Unconfigured
              providers fail with the provider's own error message. */}
          <Button
            type="button"
            variant="outline"
            className="w-full"
            disabled={loading}
            onClick={() => oauthSignIn("google")}
          >
            Continue with Google
          </Button>
          <div className="grid grid-cols-2 gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => oauthSignIn("apple")}
            >
              Apple
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => oauthSignIn("facebook")}
            >
              Facebook
            </Button>
          </div>
          <div className="relative text-center text-xs text-muted-foreground">
            <span className="bg-card px-2">or use email</span>
          </div>
        </div>

        <Tabs defaultValue="signin" className="w-full">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Create account</TabsTrigger>
          </TabsList>

          <TabsContent value="signin">
            <form onSubmit={handleSignIn} className="space-y-4 rounded-lg border bg-card p-6">
              <div className="space-y-2">
                <Label htmlFor="si-email">Email</Label>
                <Input id="si-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="si-pw">Password</Label>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!email) { setError("Enter your email above, then click Forgot password."); return; }
                      setError(null); setLoading(true);
                      const { error } = await supabase.auth.resetPasswordForEmail(email, {
                        redirectTo: `${window.location.origin}/reset-password`,
                      });
                      setLoading(false);
                      if (error) setError(error.message);
                      else setError("Check your email for a reset link.");
                    }}
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-primary"
                  >
                    Forgot password?
                  </button>
                </div>
                <Input id="si-pw" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </TabsContent>


          <TabsContent value="signup">
            {/* Account creation is a guided path now (re-review) — send new
                owners to the Get-started walkthrough instead of a cramped tab. */}
            <div className="space-y-4 rounded-lg border bg-card p-6 text-center">
              <div>
                <h2 className="text-lg font-semibold">New to {APP_NAME}?</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  We'll walk you through it: your account, your business, texting
                  preferences, and a plan — about two minutes, no card required to start.
                </p>
              </div>
              <Link to="/get-started">
                <Button className="w-full">Get started</Button>
              </Link>
            </div>
          </TabsContent>
        </Tabs>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
