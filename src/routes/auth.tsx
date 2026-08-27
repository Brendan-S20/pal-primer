import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { ensureBootstrapped, NEEDS_ORG_NAME } from "@/lib/ensure-workspace";
import { checkEmailAccount } from "@/lib/auth-entry.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2 } from "lucide-react";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/scoop";
import { PublicShell } from "@/components/PublicShell";
import { resolveIdentity } from "@/lib/offline/identity";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { withDeadline } from "@/lib/offline/run-or-queue";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import { rememberLandingPath, readLandingPath } from "@/lib/offline/read-cache";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: `Sign in - ${APP_NAME}` },
      { name: "description", content: `Sign in to ${APP_NAME}.` },
    ],
  }),
  component: AuthPage,
});

/** Two Supabase round trips. Bounded because this sits between "we know who
 *  you are" and `navigate()` — an unbounded await here strands the user on the
 *  sign-in form just as surely as failing to identify them would. Native only;
 *  the web build awaits the lookup exactly as it always has. */
const LANDING_DEADLINE_MS = 5_000;

/** The two queries themselves, shared by both platforms so there is one
 *  definition of which role lands where. */
async function lookupLandingPath(userId: string): Promise<string> {
  // Platform admins always land in the platform console — never inside a
  // tenant dashboard (impersonation uses a separate magic-link session).
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
  // owner, office_manager, or no role yet (fresh signup, where /dashboard
  // triggers onboarding).
  return "/dashboard";
}

// Where a given role should land immediately after sign-in.
//
// WEB: exactly what it has always done — await the two queries and return.
//
// NATIVE ONLY, below: both lookups are network calls, so in a dead zone this
// cannot be computed at all. It therefore remembers its answer and reads that
// back when it cannot ask; falling back to a blanket /dashboard would send a
// TECH — the one role whose whole job happens where the signal is worst — to a
// page they do not use.
//
// TWO guards, not one, and the second is the one that was missing first time.
// Checking `isDefinitelyOffline` means the known-offline case makes no request
// at all. But a try/catch alone does not save the case where we THINK we are
// online and are not: a Supabase call against a dead network does not reject
// promptly, it hangs, and `catch` never runs. Instrumenting the built bundle
// against a blocked API showed exactly that — resolveIdentity correctly
// recovered the user from the device, and then this function never returned, so
// `navigate()` was never reached and the sign-in form stayed up. Same shape as
// the bug in lib/offline/action-owner.ts: code only ever reached when offline,
// quietly depending on being online.
async function landingPathForUser(userId: string): Promise<string> {
  if (!IS_NATIVE_BUNDLE) return lookupLandingPath(userId);

  const remembered = readLandingPath();
  if (isDefinitelyOffline()) return remembered ?? "/dashboard";
  try {
    const path = await withDeadline(lookupLandingPath(userId), LANDING_DEADLINE_MS, "landing path");
    rememberLandingPath(path);
    return path;
  } catch {
    return remembered ?? "/dashboard";
  }
}

function AuthPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  /** A brand-new organization is invisible to the route guard for a minute.
   *
   *  _authenticated/route.tsx asks ensureQueryData({ queryKey: ["my-org"],
   *  staleTime: 60_000 }), and this page has usually just populated that cache
   *  with "no organization". Navigating to /onboarding or /dashboard then reads
   *  the stale answer and redirects to /no-workspace, which looks like the
   *  workspace was never created. It always was. */
  const forgetWorkspaceCache = () => {
    queryClient.removeQueries({ queryKey: ["my-org"] });
    queryClient.removeQueries({ queryKey: ["platform-context"] });
  };
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
    //
    // WEB: unchanged. `supabase.auth.getUser()` is a network call, and on the
    // hosted app that is fine — you cannot reach app.houndstack.com without one.
    if (!IS_NATIVE_BUNDLE) {
      supabase.auth.getUser().then(async ({ data }) => {
        if (!data.user) return;
        let isNewOrg: boolean | typeof NEEDS_ORG_NAME = false;
        try {
          // THIS IS THE OAUTH RETURN PATH. A provider hands back a profile, not
          // a business, so requireOrgName stops the bootstrap and /no-workspace
          // asks — the same screen, and the same validator, that /get-started
          // uses on the email path.
          isNewOrg = await ensureBootstrapped(data.user as any, { requireOrgName: true });
          if (isNewOrg === true) forgetWorkspaceCache();
        } catch (err) {
          console.error("bootstrap on landing failed", err);
        }
        if (isNewOrg === NEEDS_ORG_NAME) return navigate({ to: "/no-workspace" });
        const to = isNewOrg ? "/onboarding" : await landingPathForUser(data.user.id);
        navigate({ to });
      });
      return;
    }

    // NATIVE ONLY — THIS IS THE SCREEN A COLD LAUNCH LANDS ON. The app boots at
    // `capacitor://localhost/`, and routes/index.tsx sends `/` here
    // unconditionally, so this effect is the only thing that moves an
    // already-signed-in user onward. The web path above, run inside the binary,
    // meant a tech with no signal was parked on a sign-in form they could not
    // submit, holding a valid session that was sitting on the device the whole
    // time. iOS QA 2026-08-20 reproduced it with Wi-Fi off: kill, relaunch,
    // sign-in wall.
    //
    // resolveIdentity answers from the device when the network cannot be
    // reached, and is bounded so a hanging token refresh cannot park the app
    // here either. A REJECTED identity still falls through to the form, which
    // is correct: that is the auth server saying no, not a dead zone.
    let cancelled = false;
    void (async () => {
      const identity = await resolveIdentity();
      if (cancelled || !identity.ok) return;

      // Bootstrap is a write and needs a live user object and a network; both
      // are absent on the offline path, and skipping it is right there — an
      // existing org has nothing to bootstrap.
      let isNewOrg: boolean | typeof NEEDS_ORG_NAME = false;
      if (identity.user && !isDefinitelyOffline()) {
        try {
          isNewOrg = await ensureBootstrapped(identity.user as any, { requireOrgName: true });
          if (isNewOrg === true) forgetWorkspaceCache();
        } catch (err) {
          console.error("bootstrap on landing failed", err);
        }
      }
      if (cancelled) return;
      if (isNewOrg === NEEDS_ORG_NAME) return navigate({ to: "/no-workspace" });
      const to = isNewOrg ? "/onboarding" : await landingPathForUser(identity.userId);
      if (!cancelled) navigate({ to });
    })();
    return () => {
      cancelled = true;
    };
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
    let isNewOrg: boolean | typeof NEEDS_ORG_NAME = false;
    if (data.user) {
      try {
        isNewOrg = await ensureBootstrapped(data.user as any, { requireOrgName: true });
          if (isNewOrg === true) forgetWorkspaceCache();
      } catch (err) {
        setLoading(false);
        return setError(err instanceof Error ? err.message : "Failed to create organization");
      }
    }
    setLoading(false);
    if (isNewOrg === NEEDS_ORG_NAME) return navigate({ to: "/no-workspace" });
    const to = isNewOrg
      ? "/onboarding"
      : data.user
        ? await landingPathForUser(data.user.id)
        : "/dashboard";
    navigate({ to });
  };

  // The other half of the native flow: the system browser hands back to
  // consulting.thenorth.houndstack://auth-callback and this turns it into a
  // session. Registered once, and torn down on unmount so a remount does not
  // stack listeners and process the same URL twice.
  useEffect(() => {
    if (!IS_NATIVE_BUNDLE) return;
    let remove: (() => void) | undefined;
    let cancelled = false;

    void (async () => {
      const { App } = await import("@capacitor/app");
      const handle = await App.addListener("appUrlOpen", async ({ url }) => {
        const { completeNativeOAuth } = await import("@/lib/native-oauth");
        const result = await completeNativeOAuth(url);
        if (!result) return; // some other deep link; not ours
        setLoading(false);
        if (!result.ok) return setError(result.message);
        await afterNativeSignIn();
      });
      if (cancelled) void handle.remove();
      else remove = () => void handle.remove();
    })();

    return () => {
      cancelled = true;
      remove?.();
    };
  }, [navigate]);

  /** Where a native sign-in lands, whichever way the session arrived. Shared so
   *  the Apple sheet and the browser hand-back cannot drift apart. */
  const afterNativeSignIn = async () => {
    setLoading(false);
    const { data } = await supabase.auth.getUser();
    if (!data.user) return setError("Signed in, but the session did not stick. Try again.");
    let isNewOrg: boolean | typeof NEEDS_ORG_NAME = false;
    try {
      isNewOrg = await ensureBootstrapped(data.user as any, { requireOrgName: true });
      if (isNewOrg === true) forgetWorkspaceCache();
    } catch (err) {
      console.error("bootstrap after native sign-in failed", err);
    }
    if (isNewOrg === NEEDS_ORG_NAME) return navigate({ to: "/no-workspace" });
    const to = isNewOrg ? "/onboarding" : await landingPathForUser(data.user.id);
    navigate({ to });
  };

  const oauthSignIn = async (provider: "google" | "apple" | "facebook") => {
    const label = provider.charAt(0).toUpperCase() + provider.slice(1);
    setError(null);
    setLoading(true);

    // ── NATIVE TAKES A DIFFERENT ROUTE ENTIRELY ────────────────────────
    //
    // Not a variation on the web flow: the web flow navigates THIS WebView to
    // the provider, and Google refuses to run OAuth in an embedded WebView at
    // all (`disallowed_useragent`). The native path opens the system browser
    // instead and is handed back through a custom URL scheme. See
    // lib/native-oauth.ts for why it is implicit rather than PKCE.
    if (IS_NATIVE_BUNDLE) {
      try {
        const mod = await import("@/lib/native-oauth");
        if (provider === "apple") {
          // No browser: ASAuthorization is a system sheet and returns a token
          // directly, so there is no redirect to wait for. The session exists
          // the moment this resolves, which is why it lands rather than
          // leaving `loading` on for a hand-back that will never come.
          await mod.nativeAppleSignIn();
          await afterNativeSignIn();
          return;
        }
        await mod.nativeOAuthSignIn(provider);
        // Loading stays ON: the browser sheet is up and the session arrives
        // through appUrlOpen. Clearing it here would offer a second tap that
        // starts a second flow underneath the first.
      } catch (err) {
        setLoading(false);
        setError(err instanceof Error ? err.message : `${label} sign-in failed`);
      }
      return;
    }

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

        {/* ── OAUTH SHIPS IN THE BINARY, 2026-08-27 ────────────────────────
            This block used to be web-only, and the reason it was hidden is
            worth keeping because only half of it has gone away.

            Google still REFUSES OAuth inside an embedded WebView
            (`disallowed_useragent`), and the app's WKWebView is one. That has
            not changed and cannot be worked around. What changed is that the
            native path no longer uses the WebView: oauthSignIn opens the
            provider in SFSafariViewController via @capacitor/browser, which
            Google treats as a system browser, and the session comes back
            through a custom URL scheme. See lib/native-oauth.ts.

            Guideline 4.8 is now satisfied the way it is meant to be -- Sign in
            with Apple is OFFERED alongside the others -- rather than dodged by
            offering nothing. Apple must stay in this list for as long as
            Google or Facebook are in it.

            NEEDS ONE THING OUTSIDE THE REPO: the redirect
            consulting.thenorth.houndstack://auth-callback must be in Supabase
            → Authentication → URL Configuration → Redirect URLs. Supabase
            silently redirects to the site URL instead when it is not, which
            arrives as a sign-in that returns no session. */}
          <>
            <div className="relative my-5">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t" />
              </div>
              <div className="relative flex justify-center">
                <span className="bg-card px-2 text-xs text-muted-foreground">or continue with</span>
              </div>
            </div>
            <div className="space-y-2">
              {/* ── LIVE ON THE WEB, 2026-08-26 ──────────────────────────
                Off for one day before this, and the reason is worth keeping.
                It was enabled on 2026-08-25 and a live audit the same day found
                it ejecting buyers out of the product entirely:

                  Access blocked: This app's request is invalid
                  Error 400: redirect_uri_mismatch

                Supabase 302s to Google with
                `redirect_uri=https://api.houndstack.com/auth/v1/callback`, and
                that URI was not registered on the Google OAuth client. So the
                button worked right up until Google refused it, on Google's own
                error page, with no way back to HoundStack.

                THE PROBE CANNOT CATCH THIS, which is the part worth writing
                down. oauthSignIn fetches the authorize URL and treats >= 400 as
                "provider not enabled" — but Supabase answers 302 because
                Supabase is fine. The failure is one hop further on, at Google,
                cross-origin and opaque. The guard was built for "the provider
                is switched off" and this is "the provider is switched on and
                misconfigured", which look nothing alike from here.

                So the check that governs this button does not live in the app
                at all: `npm run check:oauth` follows the redirect to the
                provider and reads what the provider says. Run it before
                enabling anything here. It now reports Google reaching a real
                accounts.google.com sign-in page, which is why the `disabled`
                below is gone.

                It also gates on REACHABILITY rather than configuration: a
                provider switched on behind a disabled button is a warning, and
                a button somebody can press that does not work is a failure. */}
              <Button
                type="button"
                variant="outline"
                className="w-full justify-center gap-2"
                onClick={() => oauthSignIn("google")}
                disabled={loading}
              >
                <GoogleIcon /> Google
              </Button>
              {/* ── APPLE AND FACEBOOK, LIVE 2026-08-26 ──────────────────
                Both verified by following the redirect to the provider and
                reading what came back, not by trusting a toggle:

                  Apple     appleid.apple.com/auth/authorize renders the real
                            "Sign in to Apple Account" page, and the client_id
                            is consulting.thenorth.houndstack.web -- the
                            SERVICES ID. Sending the App ID there is the usual
                            first failure and Apple rejects it with
                            invalid_client and no explanation.
                  Facebook  facebook.com/dialog/oauth renders the real login.

                FACEBOOK WAS BROKEN IN A WAY THE CHECKER MISSED, and it is
                worth knowing because it was a secret leak rather than an
                outage. Its Client IDs field held an app ACCESS TOKEN --
                "APPID|APPSECRET" -- so the app secret went out in a query
                string on every attempt, and Facebook answered "Invalid App ID"
                inside a 200 page. check:oauth passed it, because it only knew
                how to read a 4xx and a redirect-to-error. It now reads the
                body and refuses any client_id containing a pipe.

                STILL UNVERIFIABLE FROM HERE: whether the Meta app is in
                Development or Live. In Development it works for anyone with a
                role on the app and fails for every real buyer, and the two are
                indistinguishable to an unauthenticated request. */}
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  className="justify-center gap-2"
                  onClick={() => oauthSignIn("apple")}
                  disabled={loading}
                >
                  <AppleIcon /> Apple
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="justify-center gap-2"
                  onClick={() => oauthSignIn("facebook")}
                  disabled={loading}
                >
                  <FacebookIcon /> Facebook
                </Button>
              </div>
            </div>
          </>
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
