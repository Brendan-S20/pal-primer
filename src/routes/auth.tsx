import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import {
  ensureBootstrapped,
  InviteRefusedError,
  NEEDS_ORG_NAME,
  pendingInviteToken,
  rememberInviteToken,
} from "@/lib/ensure-workspace";
import { checkEmailAccount } from "@/lib/auth-entry.functions";
import { lookupInviteByToken } from "@/lib/platform-onboarding.functions";
import { handOffSignupEmail, takeExistingAccount } from "@/lib/signup-email";
import {
  handOffSignIn,
  signInLanded,
  SIGN_IN_BOUNCED,
  SIGN_IN_BOUNCED_MESSAGE,
  takeBouncedSignIn,
  watchSignInLanding,
} from "@/lib/sign-in-handoff";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CheckCircle2 } from "lucide-react";
import { APP_NAME, APP_DESCRIPTION } from "@/lib/scoop";
import { PublicShell } from "@/components/PublicShell";
import { probeIdentity, resolveIdentity, trustFreshSignIn } from "@/lib/offline/identity";
import { startApiRecovery } from "@/lib/offline/api-recovery";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { withDeadline } from "@/lib/offline/run-or-queue";
import { IS_NATIVE_BUNDLE } from "@/lib/native-build";
import { rememberLandingPath, readLandingPath } from "@/lib/offline/read-cache";
import { lookupLandingPath as lookupLandingPathFrom } from "@/lib/landing-path";
import { pageTitle } from "@/lib/page-title";
import { useOfflineSignOut } from "@/hooks/useOfflineSignOut";
import { takeLinkForLanding } from "@/lib/pending-deep-link";
import {
  clearRecoveryPending,
  passwordResetRedirectHere,
  recoveryRedirectTarget,
  requestPasswordReset,
} from "@/lib/password-recovery";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      // Not "Sign in" alone (#791): this is also where a new owner starts.
      { title: pageTitle("Sign in or create an account") },
      { name: "description", content: `Sign in to ${APP_NAME}, or create an account.` },
    ],
  }),
  component: AuthPage,
});

/** Two Supabase reads, made at the same time. Bounded because this sits between "we know who
 *  you are" and `navigate()` — an unbounded await here strands the user on the
 *  sign-in form just as surely as failing to identify them would. Native only;
 *  the web build awaits the lookup exactly as it always has. */
const LANDING_DEADLINE_MS = 5_000;

/** The two queries themselves, shared by both platforms so there is one
 *  definition of which role lands where. They run side by side since #786;
 *  see lib/landing-path.ts. */
const lookupLandingPath = (userId: string) => lookupLandingPathFrom(supabase as never, userId);

// Where a given role should land immediately after sign-in.
//
// Both lookups are network calls, so with no network, or with the API not
// answering, this cannot be computed at all. It therefore remembers its answer
// and reads that back when it cannot ask; falling back to a blanket /dashboard
// would send a TECH, the one role whose whole job happens where the signal is
// worst, to a page they do not use. On both builds since #661: a web cold start
// with the API down lands here unverified too.
//
// WEB, when it can ask: await the two queries as it always has, and remember
// the answer for the next time it cannot. A lookup that fails falls back to the
// remembered answer, as on native.
//
// NATIVE, when it can ask, also bounds the lookup. TWO guards, not one, and
// the second is the one that was missing first time. Checking `isDefinitelyOffline` means the known-offline
// case makes no request at all. But a try/catch alone does not save the case
// where we THINK we are online and are not: a Supabase call against a dead
// network does not reject promptly, it hangs, and `catch` never runs.
// Instrumenting the built bundle against a blocked API showed exactly that:
// resolveIdentity correctly recovered the user from the device, and then this
// function never returned, so `navigate()` was never reached and the sign-in
// form stayed up. Same shape as the bug in lib/offline/action-owner.ts: code
// only ever reached when offline, quietly depending on being online.
async function landingPathForUser(userId: string, reachable = true): Promise<string> {
  const remembered = readLandingPath();
  if (isDefinitelyOffline() || !reachable) return remembered ?? "/dashboard";
  try {
    const lookup = lookupLandingPath(userId);
    const path = await (IS_NATIVE_BUNDLE
      ? withDeadline(lookup, LANDING_DEADLINE_MS, "landing path")
      : lookup);
    rememberLandingPath(path);
    return path;
  } catch {
    return remembered ?? "/dashboard";
  }
}

function AuthPage() {
  const navigate = useNavigate();
  const router = useRouter();

  /** Land a signed-in person on their role's page, unless a link opened the
   *  app: then go where the link points. On a cold start the link arrives
   *  while this page is still working out who is signed in, and is held for
   *  exactly this moment (lib/pending-deep-link.ts, #621). On the web too
   *  since #659: a page the _authenticated guard bounced here, or a save that
   *  found the session gone, is held the same way so sign-in returns to it. */
  const land = (to: string) => {
    const link = takeLinkForLanding();
    if (link) router.history.push(link);
    else navigate({ to });
  };
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
  // Forgot password? has its own flag (#764). It shared `loading` with Sign
  // in, so the primary button read "Signing in…" while a reset link was being
  // asked for: a reset that looked like a sign-in attempt. `loading` is still
  // set during the request (every button stays disabled, so two flows cannot
  // start at once); this decides only which words are on which button.
  const [resetting, setResetting] = useState(false);
  const [alert, setAlert] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const setError = (text: string | null) => setAlert(text ? { kind: "error", text } : null);
  // A refused invitation leaves the person signed in on a sign-in screen.
  // They need a way out of the account they are in, and back to the link.
  const [inviteRefused, setInviteRefused] = useState<InviteRefusedError | null>(null);
  const { signOut, dialog: signOutDialog } = useOfflineSignOut();
  const refuseInvite = (err: InviteRefusedError) => {
    setInviteRefused(err);
    setError(err.message);
  };
  const switchAccounts = async () => {
    if (!(await signOut())) return;
    const retry = inviteRefused?.retryToken;
    setInviteRefused(null);
    setAlert(null);
    if (retry) {
      rememberInviteToken(retry);
      setInviteToken(retry);
    }
    setStage("email");
  };
  const setInfo = (text: string) => setAlert({ kind: "info", text });
  // Set when the person came from a sign-up form whose address already has an
  // account (#765): the reset is offered as a button in the message, not only
  // as the small link beside the password label.
  const [offerReset, setOfferReset] = useState(false);
  useEffect(() => {
    const taken = takeExistingAccount();
    if (!taken) return;
    setEmail(taken);
    setStage("password");
    setOfferReset(true);
    setAlert({
      kind: "info",
      // Said for a teammate who was taken off a business too (#765): once
      // signed in, /no-workspace or /access-off is where they start their own.
      text: "That email already has a HoundStack login. Sign in with its password, or reset it if you don't know it. Once you're in, you can start your own business with it.",
    });
  }, []);

  /** A sign-in this page handed on came back here signed out (#785). Put the
   *  person back where they were, with what they typed and a reason, rather
   *  than on an empty first step. False when there was nothing to put back. */
  const restoreBouncedSignIn = (): boolean => {
    const bounced = takeBouncedSignIn();
    if (!bounced) return false;
    setEmail(bounced.email);
    if (bounced.password) setPassword(bounced.password);
    setStage("password");
    setLoading(false);
    setError(SIGN_IN_BOUNCED_MESSAGE);
    return true;
  };

  // The guard redirected the hand-off back to /auth while this page was still
  // drawn (lib/sign-in-handoff.ts watches where that navigation resolves).
  useEffect(() => {
    const onBounced = () => void restoreBouncedSignIn();
    window.addEventListener(SIGN_IN_BOUNCED, onBounced);
    return () => window.removeEventListener(SIGN_IN_BOUNCED, onBounced);
  }, []);

  // An invitation link lands here as /auth?invite=<token>. Kept before
  // anything else runs: the OAuth round-trip returns to the site root with
  // no query string, and the new-account path leaves for /get-started (#568).
  // Read after mount so the server-rendered page and the first client render
  // agree.
  const [inviteToken, setInviteToken] = useState<string | null>(null);
  useEffect(() => {
    rememberInviteToken();
    setInviteToken(pendingInviteToken());
  }, []);

  // The invitation already knows who it was sent to. Asking the person to
  // type it again is a chance to type it wrong, and the accept refuses any
  // other address (#651).
  const lookupInviteFn = useServerFn(lookupInviteByToken);
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    lookupInviteFn({ data: { token: inviteToken } })
      .then((r) => {
        if (cancelled || !r.ok || r.kind !== "staff" || !r.email) return;
        setEmail((typed) => (typed.trim() ? typed : r.email!));
      })
      .catch(() => {
        // A failed lookup leaves the box empty, as it was. Never fatal.
      });
    return () => {
      cancelled = true;
    };
  }, [inviteToken, lookupInviteFn]);

  useEffect(() => {
    // If already signed in (incl. returning from an OAuth redirect), ensure
    // org bootstrap, then land. Brand-new orgs go to the onboarding path.
    //
    // THIS IS THE SCREEN A COLD START LANDS ON, on both builds: routes/index.tsx
    // sends `/` here unconditionally, so this effect is the only thing that
    // moves an already-signed-in user onward. The native app boots at
    // `capacitor://localhost/`; a PWA or a bookmarked tab boots at `/`.
    //
    // It used to ask `supabase.auth.getUser()` on the web and stop when that
    // failed. With the API unreachable that is a signed-in user, with a session
    // and a saved day on the device, parked on a sign-in form, and nothing here
    // ever asked again: only a reload got them out (#661). The native app had
    // the same wall in a dead zone (iOS QA 2026-08-20) and with the API down
    // (#622). Both builds now take the one path below.
    //
    // resolveIdentity answers from the device when the auth server cannot be
    // reached, and is bounded so a hanging token refresh cannot park the app
    // here either. A REJECTED identity still falls through to the form, which
    // is correct: that is the auth server saying no, not a dead connection.
    let cancelled = false;
    let stopRecovery: (() => void) | null = null;

    const run = async () => {
      // A password-recovery link is not a sign-in. Supabase sends one that
      // is not on its redirect allow-list to the site root, the root sends
      // it here, and supabase-js has usually already turned its hash into a
      // session. Landing that session ran ensureBootstrapped for a person who
      // had only forgotten their password (a removed member got a brand-new
      // organization) and never let them set one. Nothing below runs until
      // /reset-password has the new password.
      const recovery = recoveryRedirectTarget(window.location.href);
      if (recovery) {
        router.history.replace(recovery);
        return;
      }
      const identity = await resolveIdentity();
      if (cancelled) return;
      if (!identity.ok) {
        // Drawn afresh (or reloaded) after a sign-in this page handed on, and
        // nobody is signed in: say so, with the form as it was (#785).
        restoreBouncedSignIn();
        // Could not ask, and nothing on this device says who is signed in.
        // Keep asking, and come back through here once the server answers,
        // rather than leaving this form as the only way on.
        if (!identity.rejected && !stopRecovery) {
          stopRecovery = startApiRecovery({
            probe: probeIdentity,
            isOffline: isDefinitelyOffline,
            target: window,
            doc: document,
            onAnswer: (result) => {
              stopRecovery = null;
              if (result === "verified" && !cancelled) void run();
            },
          });
        }
        return;
      }

      // Bootstrap is a write and needs a live user object and a network; both
      // are absent on the offline path, and skipping it is right there: an
      // existing org has nothing to bootstrap.
      //
      // Also skipped when the identity came from the device (#622, #661): the
      // network is up but the API did not answer. Every lookup in there would
      // fail, and a failed "does this person have a role?" reads as "no",
      // which sent a tech to the name-your-business screen, or left this form
      // up while a request hung. The shell then draws the saved copy and keeps
      // asking until the API answers (lib/offline/api-recovery.ts).
      //
      // ON THE WEB THIS IS ALSO THE OAUTH RETURN PATH. A provider hands back a
      // profile, not a business, so requireOrgName stops the bootstrap and
      // /no-workspace asks: the same screen, and the same validator, that
      // /get-started uses on the email path.
      let isNewOrg: boolean | typeof NEEDS_ORG_NAME = false;
      if (identity.user && identity.verified && !isDefinitelyOffline()) {
        try {
          isNewOrg = await ensureBootstrapped(identity.user as any, { requireOrgName: true });
          if (isNewOrg === true) forgetWorkspaceCache();
        } catch (err) {
          // An invitation refused on the way back from Google is the one
          // error here a person has to read. Landing anyway would put them on
          // "name your business" with no idea why (#568).
          if (err instanceof InviteRefusedError) {
            if (!cancelled) refuseInvite(err);
            return;
          }
          console.error("bootstrap on landing failed", err);
        }
      }
      if (cancelled) return;
      // Signed in after all: a hand-off still held is not a failure to report.
      signInLanded();
      if (isNewOrg === NEEDS_ORG_NAME) return navigate({ to: "/no-workspace" });
      if (isNewOrg) return navigate({ to: "/onboarding" });
      const to = await landingPathForUser(identity.userId, identity.verified);
      if (!cancelled) land(to);
    };
    void run();
    return () => {
      cancelled = true;
      stopRecovery?.();
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
    // Signed in with a password: whatever reset this tab started is over.
    clearRecoveryPending();
    let isNewOrg: boolean | typeof NEEDS_ORG_NAME = false;
    if (data.user) {
      // The auth server verified this user just now. Without this the guard
      // asks it again on the next navigation, and a refusal there bounced a
      // good password back to /auth with no word of why (#785).
      trustFreshSignIn(data.user);
      try {
        isNewOrg = await ensureBootstrapped(data.user as any, { requireOrgName: true });
        if (isNewOrg === true) forgetWorkspaceCache();
      } catch (err) {
        setLoading(false);
        if (err instanceof InviteRefusedError) return refuseInvite(err);
        return setError(err instanceof Error ? err.message : "Failed to create organization");
      }
    }
    setLoading(false);
    // From here it is the router's, and the guard's, call. If the navigation
    // below resolves back on /auth, the page is told and puts the form back
    // with a reason instead of looking like a first visit (#785,
    // lib/sign-in-handoff.ts).
    handOffSignIn(email, password);
    watchSignInLanding((event, fn) => router.subscribe(event, fn));
    if (isNewOrg === NEEDS_ORG_NAME) return navigate({ to: "/no-workspace" });
    if (isNewOrg) return navigate({ to: "/onboarding" });
    land(data.user ? await landingPathForUser(data.user.id) : "/dashboard");
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
      // Not App.addListener: Capacitor gives a cold-start link to the first
      // listener only, and this one, one import away, used to beat the root's
      // and drop the staff link it was handed (#621). lib/app-url-open.ts owns
      // the one listener and sends this page only what is not a page link.
      const { onAppUrl } = await import("@/lib/app-url-open");
      const off = await onAppUrl("other", (url) => {
        void (async () => {
          const { completeNativeOAuth } = await import("@/lib/native-oauth");
          const result = await completeNativeOAuth(url);
          if (!result) return; // some other deep link; not ours
          setLoading(false);
          if (!result.ok) return setError(result.message);
          await afterNativeSignIn();
        })();
      });
      if (cancelled) off();
      else remove = off;
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
      if (err instanceof InviteRefusedError) return refuseInvite(err);
      console.error("bootstrap after native sign-in failed", err);
    }
    if (isNewOrg === NEEDS_ORG_NAME) return navigate({ to: "/no-workspace" });
    if (isNewOrg) return navigate({ to: "/onboarding" });
    land(await landingPathForUser(data.user.id));
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
        // The invitation goes with them. Without it /get-started asks for a
        // business name and builds a new one, and the invite stays pending.
        // The address does not ride in the URL (#651): it is handed over in
        // this tab's sessionStorage.
        handOffSignupEmail(email);
        navigate({
          to: "/get-started",
          search: { ...(inviteToken ? { invite: inviteToken } : {}) } as never,
        });
      }
    } catch (err) {
      setLoading(false);
      setError(err instanceof Error ? err.message : "Couldn't check that email. Try again.");
    }
  };

  /** Straight to the Get-started walkthrough (#791). An address already typed
   *  goes with it the same way Continue hands it on (#651), and one that turns
   *  out to have an account comes back here on the password step (#765). */
  const createAccount = () => {
    setAlert(null);
    if (emailValid) handOffSignupEmail(email);
    navigate({ to: "/get-started", search: {} as never });
  };

  // Asks nothing about memberships, and must not: an account with no business
  // is exactly who needs this most (#765).
  // One helper for every reset request (lib/password-recovery.ts): the
  // redirect is /reset-password on the canonical origin (the iOS app's own
  // scheme in the iOS app), and a failed send says so instead of "check your
  // email" for a message that is never coming.
  const forgotPassword = async () => {
    setAlert(null);
    setOfferReset(false);
    if (!emailValid) return setError("Enter your email address first.");
    setLoading(true);
    const r = await requestPasswordReset(supabase, email, await passwordResetRedirectHere());
    setLoading(false);
    if (!r.ok) setError(r.message);
    else setInfo(`Check ${r.sentTo} for a reset link. It works once, for an hour.`);
  };

  return (
    <PublicShell tagline={APP_DESCRIPTION}>
      <div className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
        <h1 className="text-lg font-semibold">
          {stage === "email" ? "Sign in or create your account" : "Welcome back"}
        </h1>
        <p className="mt-0.5 text-sm text-muted-foreground">
          {stage === "email"
            ? inviteToken
              ? "Enter the email address your invitation was sent to."
              : "Enter your work email to continue."
            : email}
        </p>

        {stage === "email" ? (
          <form onSubmit={continueWithEmail} className="mt-4 space-y-3">
            <div className="space-y-2">
              <Label htmlFor="si-email">Work email</Label>
              <Input
                id="si-email"
                type="email"
                required
                // Not in the app (R2-56): on a cold launch the keyboard came up
                // over the splash, and on a signed-in launch it flashed over
                // the dashboard on the way through. A tap brings it up. The web
                // app keeps the focus: there it costs nothing.
                autoFocus={!IS_NATIVE_BUNDLE}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbusiness.com"
              />
            </div>
            <Button type="submit" disabled={loading || !emailValid} className="w-full">
              {loading ? "Checking…" : "Continue"}
            </Button>
            {/* A new owner's way in, as a control rather than a line of footer
                copy (#791). The screen read as sign-in only. Not offered on an
                invitation: an invited teammate joins a business, and the email
                step above already carries the invite to /get-started. */}
            {!inviteToken && (
              <div className="space-y-2 pt-1">
                <p className="text-center text-sm text-muted-foreground">New to {APP_NAME}?</p>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={createAccount}
                  disabled={loading}
                >
                  Create an account
                </Button>
              </div>
            )}
          </form>
        ) : (
          <form onSubmit={handleSignIn} className="mt-4 space-y-3">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="si-pw">Password</Label>
                <button
                  type="button"
                  onClick={() => {
                    setResetting(true);
                    void forgotPassword().finally(() => setResetting(false));
                  }}
                  disabled={loading}
                  aria-busy={resetting || undefined}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-primary"
                >
                  {resetting ? "Sending reset link…" : "Forgot password?"}
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
              {loading && !resetting ? "Signing in…" : "Sign in"}
            </Button>
            <button
              type="button"
              onClick={() => {
                setStage("email");
                setPassword("");
                setAlert(null);
                setOfferReset(false);
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
          <div className="min-w-0 space-y-2 break-words">
            <p>{alert.text}</p>
            {inviteRefused && (
              <Button type="button" variant="outline" size="sm" onClick={switchAccounts}>
                Sign out and switch accounts
              </Button>
            )}
            {offerReset && stage === "password" && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setResetting(true);
                  void forgotPassword().finally(() => setResetting(false));
                }}
                disabled={loading}
                aria-busy={resetting || undefined}
              >
                {resetting ? "Sending reset link…" : "Email me a reset link"}
              </Button>
            )}
          </div>
        </div>
      )}
      {signOutDialog}
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
