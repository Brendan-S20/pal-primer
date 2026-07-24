import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { bootstrapOrganization } from "@/lib/org.functions";
import { checkEmailAccount } from "@/lib/auth-entry.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2 } from "lucide-react";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/scoop";
import { PublicShell } from "@/components/PublicShell";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: `Sign in - ${APP_NAME}` },
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
async function ensureBootstrapped(user: {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, any> | null;
}): Promise<boolean> {
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
    (typeof md.org_name === "string" && md.org_name.trim()) || `${displayName}'s Organization`;

  // OAuth signups round-trip through the provider, so referral/UTM attribution
  // from /sign-up rides localStorage (see signup-attribution.ts).
  const { readSignupAttribution, clearSignupAttribution } =
    await import("@/lib/signup-attribution");
  const attribution = readSignupAttribution();
  await bootstrapOrganization({
    data: {
      orgName,
      displayName,
      refCode: attribution.ref,
      utm: attribution.utm,
      promoCode: attribution.promo,
    },
  });
  clearSignupAttribution();
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
  const [stage, setStage] = useState<"email" | "password">("email");
  const [loading, setLoading] = useState(false);
  const [alert, setAlert] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const setError = (text: string | null) => setAlert(text ? { kind: "error", text } : null);
  const setInfo = (text: string) => setAlert({ kind: "info", text });

  useEffect(() => {
    // If already signed in (incl. returning from an OAuth redirect), ensure
    // org bootstrap, then land — brand-new orgs go to the onboarding path.
    supabase.auth.getUser().then(async ({ data }) => {
      if (!data.user) return;
      let isNewOrg = false;
      try {
        isNewOrg = await ensureBootstrapped(data.user as any);
      } catch (err) {
        console.error("bootstrap on landing failed", err);
      }
      const to = isNewOrg ? "/onboarding" : await landingPathForUser(data.user.id);
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
    const to = isNewOrg
      ? "/onboarding"
      : data.user
        ? await landingPathForUser(data.user.id)
        : "/dashboard";
    navigate({ to });
  };

  const oauthSignIn = async (provider: "google" | "apple" | "facebook") => {
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    setError(null);
    setLoading(true);
    try {
      // All three providers go through Supabase's native OAuth flow. This
      // project's auth is an external Supabase project — there is no
      // Lovable-managed OAuth broker on it, so the old cloud-auth wrapper
      // clicked into nothing ("Google does nothing"). signInWithOAuth always
      // navigates or returns a visible error, and the post-redirect landing
      // (incl. new-org → /onboarding) is handled by the mount effect.
      const { data: oauthData, error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider,
        // Don't navigate yet — a provider that isn't enabled in Supabase
        // (e.g. Apple/Facebook pre-configuration) makes the authorize URL
        // render a raw "Unsupported provider" API error page. Probe first so
        // the user gets an in-app message instead of a dead end (P1.10).
        options: { redirectTo: window.location.origin, skipBrowserRedirect: true },
      });
      if (oauthErr) {
        setLoading(false);
        const msg = /unsupported|not enabled|provider is not/i.test(oauthErr.message ?? "")
          ? `${label} sign-in isn't available yet. Try email or Google.`
          : (oauthErr.message ?? `${label} sign-in failed`);
        return setError(msg);
      }
      if (!oauthData?.url) {
        setLoading(false);
        return setError(`${label} sign-in failed. Try again.`);
      }
      try {
        const probe = await fetch(oauthData.url, { redirect: "manual" });
        // A healthy authorize URL 302-redirects to the provider (opaque to
        // fetch); a disabled provider answers 4xx with an error body.
        if (probe.status >= 400) {
          setLoading(false);
          return setError(`${label} sign-in isn't available yet. Use email or Google instead.`);
        }
      } catch {
        // Probe blocked (CORS/network) — fall through and navigate normally.
      }
      window.location.assign(oauthData.url);
      // Browser is redirecting to the provider.
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : `${label} sign-in failed`);
    }
  };

  // Identifier-first (ERP-style rework): email first; if the account exists
  // we reveal the password step, otherwise we hand off to the Get-started
  // walkthrough with the email carried over.
  const checkFn = useServerFn(checkEmailAccount);
  const emailValid = /.+@.+\..+/.test(email);

  const continueWithEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!emailValid) return;
    setError(null);
    setLoading(true);
    try {
      const r = await checkFn({ data: { email: email.trim() } });
      setLoading(false);
      if (r.exists) {
        setStage("password");
      } else {
        navigate({ to: "/get-started", search: { email: email.trim() } as never });
      }
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : "Couldn't check that email. Try again.");
    }
  };

  const forgotPassword = async () => {
    setAlert(null);
    setLoading(true);
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setLoading(false);
    if (error) setError(error.message);
    else setInfo("Check your email for a reset link.");
  };

  return (
    <PublicShell tagline={APP_DESCRIPTION}>
        <div className="rounded-xl border bg-card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">
            {stage === "email" ? "Sign in or create your account" : "Welcome back"}
          </h1>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {stage === "email" ? "Enter your work email to continue." : email}
          </p>

          {stage === "email" ? (
            <form onSubmit={continueWithEmail} className="mt-4 space-y-3">
              <div className="space-y-2">
                <Label htmlFor="si-email">Work email</Label>
                <Input
                  id="si-email"
                  type="email"
                  required
                  autoFocus
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@yourbusiness.com"
                />
              </div>
              <Button type="submit" disabled={loading || !emailValid} className="w-full">
                {loading ? "Checking…" : "Continue"}
              </Button>
            </form>
          ) : (
            <form onSubmit={handleSignIn} className="mt-4 space-y-3">
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="si-pw">Password</Label>
                  <button
                    type="button"
                    onClick={forgotPassword}
                    disabled={loading}
                    className="text-xs text-muted-foreground underline underline-offset-2 hover:text-primary"
                  >
                    Forgot password?
                  </button>
                </div>
                <Input
                  id="si-pw"
                  type="password"
                  required
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={loading} className="w-full">
                {loading ? "Signing in…" : "Sign in"}
              </Button>
              <button
                type="button"
                onClick={() => {
                  setStage("email");
                  setPassword("");
                  setAlert(null);
                }}
                className="w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-primary"
              >
                Use a different email
              </button>
            </form>
          )}

          {/* OAuth lives under the email sign-in (re-review), with brand marks. */}
          <div className="relative my-5">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-card px-2 text-xs text-muted-foreground">or continue with</span>
            </div>
          </div>
          <div className="space-y-2">
            {/* Google disabled too for now (Brendan, 2026-07-14) — same teaser
                treatment as Apple/Facebook until the provider config is
                settled. Re-wire onClick={() => oauthSignIn("google")} to
                re-enable; the whole flow underneath stays built. */}
            <Button
              type="button"
              variant="outline"
              className="w-full justify-center gap-2"
              disabled
              title="Coming soon"
            >
              <GoogleIcon /> Google
              <span className="text-[10px] font-normal text-muted-foreground">soon</span>
            </Button>
            {/* Apple/Facebook aren't configured yet — shown disabled as a
                teaser rather than wired to a broken flow (Brendan's call). */}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                className="justify-center gap-2"
                disabled
                title="Coming soon"
              >
                <AppleIcon /> Apple
                <span className="text-[10px] font-normal text-muted-foreground">soon</span>
              </Button>
              <Button
                type="button"
                variant="outline"
                className="justify-center gap-2"
                disabled
                title="Coming soon"
              >
                <FacebookIcon /> Facebook
                <span className="text-[10px] font-normal text-muted-foreground">soon</span>
              </Button>
            </div>
          </div>
        </div>

        {alert && (
          <div
            role={alert.kind === "error" ? "alert" : "status"}
            className={
              alert.kind === "error"
                ? "flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
                : "flex items-start gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-400"
            }
          >
            {alert.kind === "info" && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />}
            <span>{alert.text}</span>
          </div>
        )}

        <p className="text-center text-xs text-muted-foreground">
          New here? Entering your email above walks you straight into account setup.
        </p>
    </PublicShell>
  );
}

// Brand marks (lucide dropped brand icons) — minimal inline SVGs.
function GoogleIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l-.02.15 3.5 2.7.24.02c2.2-2 3.5-5 3.5-8.6z"
      />
      <path
        fill="#34A853"
        d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.8-2.9c-1 .7-2.4 1.2-4.1 1.2-3.2 0-5.8-2.1-6.8-4.9l-.14.01-3.6 2.8-.05.13C3.4 21.3 7.4 24 12 24z"
      />
      <path
        fill="#FBBC05"
        d="M5.2 14.5c-.25-.7-.4-1.5-.4-2.3s.14-1.6.38-2.3l-.01-.16-3.65-2.8-.12.06C.5 8.6 0 10.2 0 12.2s.5 3.6 1.4 5.2l3.8-2.9z"
      />
      <path
        fill="#EA4335"
        d="M12 4.7c2.3 0 3.8 1 4.7 1.8l3.4-3.3C18 1.2 15.2 0 12 0 7.4 0 3.4 2.7 1.4 6.9l3.8 2.9C6.2 6.9 8.8 4.7 12 4.7z"
      />
    </svg>
  );
}
function AppleIcon() {
  return (
    <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M16.4 12.8c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.85-1.6.02-3.1 1-4 2.4-1.7 3-0.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3.1 2.4 1.2-.05 1.7-.8 3.2-.8s1.9.8 3.2.75c1.3-.02 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8-.03-.01-2.6-1-2.6-3.9zM14 5.6c.7-.8 1.1-1.9 1-3-1 .04-2.1.65-2.8 1.4-.6.7-1.2 1.9-1 3 1.1.1 2.2-.55 2.8-1.4z" />
    </svg>
  );
}
function FacebookIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#1877F2"
        d="M24 12a12 12 0 1 0-13.9 11.9v-8.4H7.1V12h3.1V9.4c0-3 1.8-4.7 4.6-4.7 1.3 0 2.7.24 2.7.24v3h-1.5c-1.5 0-2 .93-2 1.9V12h3.4l-.54 3.5h-2.8v8.4A12 12 0 0 0 24 12z"
      />
      <path
        fill="#fff"
        d="M16.7 15.5 17.2 12h-3.4V9.7c0-1 .47-1.9 2-1.9h1.5v-3s-1.4-.24-2.7-.24c-2.8 0-4.6 1.7-4.6 4.7V12H7.1v3.5h3.1v8.4a12 12 0 0 0 3.9 0v-8.4h2.8z"
      />
    </svg>
  );
}
