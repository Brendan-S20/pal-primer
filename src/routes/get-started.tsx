import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  clearSignupAttribution,
  readSignupAttribution,
  stashSignupAttribution,
  stashSignupPromoCode,
} from "@/lib/signup-attribution";
import { supabase } from "@/integrations/supabase/client";
import { bootstrapOrganization, recordSmsConsent, validateSignupCode } from "@/lib/org.functions";
import {
  checkEmailAccount,
  checkNewPassword,
  registerAccount,
  sendEmailVerification,
} from "@/lib/auth-entry.functions";
import { lookupInviteByToken } from "@/lib/platform-onboarding.functions";
import { acceptPendingInvite, rememberInviteToken } from "@/lib/ensure-workspace";
import { humanizeRole } from "@/lib/humanize";
import { toast } from "sonner";
import { sendWithVerifyNotice } from "@/lib/verify-email-copy";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicShell } from "@/components/PublicShell";
import { PasswordField } from "@/components/PasswordField";
import {
  isPasswordAcceptable,
  isPasswordRejection,
  passwordRejectionMessage,
} from "@/lib/password-policy";
import { SMS_CONSENT_TEXT, SmsOptInFields, SmsOptInHeading } from "@/components/SmsOptInFields";
import { APP_NAME } from "@/lib/scoop";
import { isValidOrgName } from "@/lib/dna-linkage";
import { pageTitle } from "@/lib/page-title";
import { deviceTimezone } from "@/lib/org-timezone";
import {
  EMAIL_ALREADY_REGISTERED,
  handOffExistingAccount,
  handOffSignupEmail,
  takeSignupEmail,
} from "@/lib/signup-email";
import { finishSignup, newSignupProgress, signupErrorMessage } from "@/lib/finish-signup";
import {
  clearSignupDraft,
  readSignupDraft,
  saveSignupDraft,
  SIGNUP_INTERRUPTED_MESSAGE,
} from "@/lib/signup-draft";

// The Get-started walkthrough (Brendan's re-review): account creation is a
// guided path, not a tab on the sign-in card. Steps: account → business →
// texting consent (Twilio/TCPA compliance) → then straight into /onboarding
// for the plan picker + embedded payment, one continuous flow.
export const Route = createFileRoute("/get-started")({
  // ?email= is still read so an old link works, but it is moved into
  // sessionStorage and taken off the URL on arrival (#651). /auth and
  // /sign-up hand the address over in sessionStorage to begin with.
  // ref/utm_* also land here directly when a marketing link skips /sign-up.
  validateSearch: (s: Record<string, unknown>) => ({
    email: typeof s.email === "string" ? s.email : undefined,
    // An invitation token, carried from /auth?invite=… (#568). With one, this
    // page creates the account and joins the inviting business; it never asks
    // for a business name.
    invite: typeof s.invite === "string" ? s.invite : undefined,
    ref: typeof s.ref === "string" ? s.ref : undefined,
    utm_source: typeof s.utm_source === "string" ? s.utm_source : undefined,
    utm_medium: typeof s.utm_medium === "string" ? s.utm_medium : undefined,
    utm_campaign: typeof s.utm_campaign === "string" ? s.utm_campaign : undefined,
    utm_term: typeof s.utm_term === "string" ? s.utm_term : undefined,
    utm_content: typeof s.utm_content === "string" ? s.utm_content : undefined,
    // The service line the visitor came for (site-r2-03). Validated by
    // requestedServiceLine when it is stashed; an unknown value is ignored.
    service: typeof s.service === "string" ? s.service : undefined,
  }),
  head: () => ({
    meta: [
      { title: pageTitle("Get started") },
      { name: "description", content: `Create your ${APP_NAME} workspace.` },
    ],
  }),
  component: GetStartedPage,
});

// The consent sentence and the opt-in fields live in one shared component so
// the public evidence page at /legal/sms-opt-in renders exactly what this step
// renders (#451). Re-exported here for ensure-workspace.ts.
export { SMS_CONSENT_TEXT } from "@/components/SmsOptInFields";

// Not "Texting". The last step creates the workspace; the texting opt-in is one
// optional control inside it. Naming the step after the opt-in made messaging
// look like a required stage of signing up — Twilio read the flow that way and
// rejected the toll-free verification for it (30475).
const STEPS = ["Your account", "Your business", "Finish"] as const;

/**
 * A taken address goes to sign-in, never to an error on a sign-up form (#765).
 *
 * "That email already has an account. Sign in instead." was true and left the
 * person on a form that could not proceed, with a password they may not know.
 * A teammate who was taken off a business and tries to start again lands here
 * first. /auth opens on the password step with the address filled in and
 * "Forgot password?" beside it. An invitation token, if there is one, is
 * already kept (rememberInviteToken) and is accepted after that sign-in.
 */
function sendToSignIn(navigate: ReturnType<typeof useNavigate>, email: string) {
  handOffExistingAccount(email);
  navigate({ to: "/auth" });
}

/** True when a thrown error is registerAccount's "already has an account". */
function isTakenEmail(err: unknown): boolean {
  return err instanceof Error && err.message === EMAIL_ALREADY_REGISTERED;
}

function GetStartedPage() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  // An address in the URL is in history, in referrers and in analytics. Take
  // it off before anything else (#651); the page reads it from the hand-off.
  useEffect(() => {
    if (!search.email) return;
    handOffSignupEmail(search.email);
    navigate({ to: "/get-started", search: { ...search, email: undefined }, replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search.email]);
  if (search.email) return null;
  return search.invite ? <JoinTeamPage token={search.invite} /> : <NewBusinessPage />;
}

function NewBusinessPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // This address has a pending teammate invitation (#651). Then the page is a
  // join: it asks for a name, never for a business, and never says
  // "workspace". Decided on step 0, before the business step can be seen.
  const [invited, setInvited] = useState(false);
  const [checking, setChecking] = useState(false);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);
  // How far "Create my workspace" got, so a retry resumes rather than
  // repeats (src/lib/finish-signup.ts). Above the `invited` early
  // return, so it is called on every render.
  const progress = useRef(newSignupProgress());
  // Drawn again partway through, with no password to hand (it is never kept):
  // the last step asks for it once more (#785 (a)).
  const [askPasswordAgain, setAskPasswordAgain] = useState(false);
  // The auth server refused a password the rules passed (its leaked-password
  // check, #807). Said on a password field on the step the person is on, so
  // nothing else they typed has to be walked back through or typed again.
  const [passwordRejected, setPasswordRejected] = useState<string | null>(null);
  // What is in the field right now, for an answer that arrives after the
  // person has typed on.
  const passwordNow = useRef("");
  const changePassword = (value: string) => {
    passwordNow.current = value;
    setPassword(value);
    setPasswordRejected(null);
  };
  // The leaked-password check, asked of the server on the FIRST step (#807):
  // when the person leaves the field, and again (the same answer, not a
  // second request) when they press Continue. Only a password the shared
  // rules already pass is sent; "couldn't tell" lets them carry on, and
  // registerAccount at the end is still the check that decides.
  const earlyCheck = useRef<{ value: string; answer: Promise<string | null> } | null>(null);
  const passwordServerProblem = (value: string): Promise<string | null> => {
    if (!isPasswordAcceptable(value)) return Promise.resolve(null);
    if (earlyCheck.current?.value !== value) {
      const answer = Promise.resolve()
        .then(() => checkNewPassword({ data: { password: value } }))
        .then((r) => (r && r.ok === false && r.problem ? r.problem : null))
        .catch(() => null);
      earlyCheck.current = { value, answer };
    }
    return earlyCheck.current.answer;
  };
  const checkPasswordOnLeave = () => {
    const value = passwordNow.current;
    void passwordServerProblem(value).then((problem) => {
      if (problem && passwordNow.current === value) setPasswordRejected(problem);
    });
  };
  // Nothing is written until what was kept has been read back, so the first,
  // empty render can never overwrite a draft it was about to restore.
  const draftRead = useRef(false);

  // "Promo or referral code" (optional). Validated server-side for a friendly
  // hint, but an invalid code NEVER blocks signup — the server drops bad codes
  // at org creation anyway.
  const [promoCode, setPromoCode] = useState("");
  const [promoStatus, setPromoStatus] = useState<{ valid: boolean; message: string } | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  // A page drawn afresh partway through sign-up (a reload, a remount, a second
  // tab) used to start again from an empty first step with no word of why
  // (#785 (a)). What was typed comes back, at the step it was on, and a create
  // that was still working when the page went says so.
  useEffect(() => {
    const handed = takeSignupEmail();
    const draft = readSignupDraft();
    const sameSignup =
      draft && (!handed || handed.toLowerCase() === draft.email.trim().toLowerCase());
    if (draft && sameSignup) {
      setEmail((typed) => typed || draft.email);
      setOrgName(draft.orgName);
      setDisplayName(draft.displayName);
      setPhone(draft.phone);
      setSmsConsent(draft.smsConsent);
      if (draft.promoCode) setPromoCode(draft.promoCode);
      const step1Ok = isValidOrgName(draft.orgName) && draft.displayName.trim().length > 0;
      const step = draft.step === 2 && !step1Ok ? 1 : draft.step;
      setStep(step);
      if (step > 0) setAskPasswordAgain(true);
      if (draft.creating) setError(SIGNUP_INTERRUPTED_MESSAGE);
    } else {
      if (draft) clearSignupDraft();
      if (handed) setEmail((typed) => typed || handed);
    }
    draftRead.current = true;
  }, []);

  useEffect(() => {
    if (!draftRead.current || invited) return;
    saveSignupDraft({
      step,
      email,
      orgName,
      displayName,
      phone,
      smsConsent,
      promoCode,
      creating: busy && step === 2,
    });
  }, [step, email, orgName, displayName, phone, smsConsent, promoCode, busy, invited]);

  const checkPromo = async (value: string) => {
    const code = value.trim();
    stashSignupPromoCode(code); // survives the OAuth bounce (auth.tsx bootstrap)
    if (!code) {
      setPromoStatus(null);
      return;
    }
    setPromoChecking(true);
    try {
      const r = await validateSignupCode({ data: { code } });
      setPromoStatus(r);
    } catch {
      setPromoStatus(null); // validation hiccups must not scare anyone off signup
    } finally {
      setPromoChecking(false);
    }
  };

  // Persist any ref/utm params so they survive the multi-step flow (and the
  // OAuth round-trip) until org creation; a referral link's code pre-fills the
  // promo box so the new owner can SEE their referral is attached.
  useEffect(() => {
    stashSignupAttribution(search as Record<string, unknown>);
    const stashed = readSignupAttribution();
    const prefill = stashed.promo ?? stashed.ref;
    if (prefill) {
      setPromoCode(prefill);
      checkPromo(prefill);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const step0Valid = /.+@.+\..+/.test(email) && isPasswordAcceptable(password);
  const passwordOk = isPasswordAcceptable(password);

  const continueFromAccount = async () => {
    setError(null);
    setChecking(true);
    const typed = password;
    const passwordProblem = passwordServerProblem(typed);
    // A new address: the password is about to be this account's, so a refusal
    // the auth server would give at the end is given here, on the field it is
    // about, and Continue stays put. Never rejects.
    const passwordRefused = async () => {
      const problem = await passwordProblem;
      if (!problem) return false;
      if (passwordNow.current === typed) setPasswordRejected(problem);
      document.getElementById("gs-pass")?.focus();
      return true;
    };
    try {
      const r = await checkEmailAccount({ data: { email: email.trim() } });
      if (r.exists) {
        sendToSignIn(navigate, email);
        return;
      }
      if (await passwordRefused()) return;
      if (r.pendingInvite) {
        setInvited(true);
        return;
      }
    } catch {
      // The check is a courtesy. finish() still joins a pending invitation
      // before it would build anything.
      if (await passwordRefused()) return;
    } finally {
      setChecking(false);
    }
    setStep(1);
  };

  const join = async () => {
    setError(null);
    setBusy(true);
    try {
      await registerAccount({
        data: { email: email.trim(), password, displayName: displayName.trim() },
      });
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) throw signInErr;
      if (!(await acceptPendingInvite(null))) {
        throw new Error(
          "Your account is created, but the invitation could not be used. Open the link in the invitation email, or ask for a new one.",
        );
      }
      clearSignupAttribution();
      clearSignupDraft();
      navigate({ to: "/auth" });
    } catch (err) {
      setBusy(false);
      if (isPasswordRejection(err)) {
        // The join form has no password field of its own (it was typed on
        // the first step); one appears and stays while a new one is typed.
        setAskPasswordAgain(true);
        setPasswordRejected(passwordRejectionMessage((err as Error).message));
        return;
      }
      if (isTakenEmail(err)) return sendToSignIn(navigate, email);
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };

  if (invited) {
    return (
      <PublicShell tagline="Join your team on HoundStack." className="max-w-lg">
        <div className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (displayName.trim() && passwordOk && !passwordRejected) join();
            }}
          >
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">You have been invited</h1>
              <p className="text-sm text-muted-foreground">
                <span className="break-words">{email.trim()}</span> has an invitation to join a
                team. Add your name to finish.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="gs-name">Your name</Label>
              <Input
                id="gs-name"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Doe"
                maxLength={80}
              />
              <p className="text-xs text-muted-foreground">
                This is how your team and customers will see you.
              </p>
            </div>
            {askPasswordAgain && (
              <PasswordField
                id="gs-pass-join"
                value={password}
                onChange={changePassword}
                serverError={passwordRejected}
              />
            )}
            {error && (
              <p className="text-sm text-destructive">
                {error}{" "}
                <Link to="/auth" className="underline">
                  Sign in instead
                </Link>
              </p>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setInvited(false);
                  setError(null);
                  setPasswordRejected(null);
                }}
                disabled={busy}
              >
                Back
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={!displayName.trim() || !passwordOk || !!passwordRejected || busy}
              >
                {busy ? "Joining…" : "Create account and join"}
              </Button>
            </div>
          </form>
        </div>
      </PublicShell>
    );
  }
  const step1Valid = isValidOrgName(orgName) && displayName.trim().length > 0;

  const finish = async () => {
    setError(null);
    setBusy(true);
    try {
      const outcome = await finishSignup(
        { email, password, orgName, displayName, phone, smsConsent, promoCode },
        progress.current,
        {
          registerAccount: (a) => registerAccount(a as never),
          signIn: (e, p) => supabase.auth.signInWithPassword({ email: e, password: p }),
          acceptPendingInvite: () => acceptPendingInvite(null),
          bootstrapOrganization: (a) => bootstrapOrganization(a as never),
          recordSmsConsent: (a) => recordSmsConsent(a),
          // The notice about the verify link (#776) is drawn when the send
          // itself settles, which can be after finishSignup returns (#824).
          sendEmailVerification: sendWithVerifyNotice(
            () => sendEmailVerification(),
            email,
            (message) => toast(message, { duration: 15000 }),
          ),
          readAttribution: readSignupAttribution,
          clearAttribution: clearSignupAttribution,
          timezone: deviceTimezone,
          consentText: SMS_CONSENT_TEXT,
          // Signup is not blocked and the account is already created --
          // losing a discount is not worth losing a customer over -- but it is
          // said here and held on screen.
          onPromoLost: (code) =>
            toast.warning(
              `We could not attach promo code ${code} to your account. Your account is set up. Contact us before you subscribe so we can apply it.`,
              { duration: 15000 },
            ),
        },
      );
      // The kept draft (#785) is spent on both ways out, as before.
      if (outcome === "joined-team") {
        clearSignupDraft();
        navigate({ to: "/auth" });
        return;
      }
      clearSignupDraft();
      navigate({ to: "/onboarding" });
    } catch (err) {
      setBusy(false);
      // A refused password, before any account exists: put the password
      // field on this step with the server's reason beside it (#807). Not a
      // line at the foot of a step with no password on it, and never back to
      // the first step (#785).
      if (!progress.current.registered && isPasswordRejection(err)) {
        setAskPasswordAgain(true);
        setPasswordRejected(passwordRejectionMessage((err as Error).message));
        return;
      }
      // Only before this page created the account: after that, a retry skips
      // registerAccount (#795) and a taken address is not the problem.
      if (!progress.current.registered && isTakenEmail(err)) return sendToSignIn(navigate, email);
      setError(signupErrorMessage(err, progress.current));
    }
  };

  return (
    <PublicShell tagline="Set up your workspace in about two minutes." className="max-w-lg">
      {/* Not on step 0: whether there is a business step at all is only
            known once the address has been checked (#651). */}
      {step > 0 && (
        <div className="flex items-center gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-1 items-center gap-2">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  i <= step
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground"
                }`}
              >
                {i < step ? "✓" : i + 1}
              </div>
              <span
                className={`text-xs sm:text-sm ${i === step ? "font-medium" : "text-muted-foreground"}`}
              >
                {label}
              </span>
              {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
            </div>
          ))}
        </div>
      )}

      <div className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
        {step === 0 && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (step0Valid && !passwordRejected && !checking) void continueFromAccount();
            }}
          >
            <div>
              <h1 className="text-lg font-semibold">Create your account</h1>
              <p className="text-sm text-muted-foreground">You'll use this to sign in.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="gs-email">Work email</Label>
              <Input
                id="gs-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourbusiness.com"
              />
            </div>
            <PasswordField
              id="gs-pass"
              value={password}
              onChange={changePassword}
              onBlur={checkPasswordOnLeave}
              serverError={passwordRejected}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="submit"
              className="w-full"
              disabled={!step0Valid || !!passwordRejected || checking}
            >
              {checking ? "Checking…" : "Continue"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link to="/auth" className="underline">
                Sign in
              </Link>
            </p>
          </form>
        )}

        {step === 1 && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (step1Valid) setStep(2);
            }}
          >
            <div>
              <h1 className="text-lg font-semibold">About your business</h1>
              <p className="text-sm text-muted-foreground">
                This names your workspace. You can change it later.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="gs-org">Business name</Label>
              <Input
                id="gs-org"
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
              <Label htmlFor="gs-name">Your name</Label>
              <Input
                id="gs-name"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Doe"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="gs-promo">
                Promo or referral code{" "}
                <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Input
                id="gs-promo"
                value={promoCode}
                onChange={(e) => {
                  setPromoCode(e.target.value);
                  setPromoStatus(null);
                }}
                onBlur={() => checkPromo(promoCode)}
                placeholder="e.g. LAUNCH20"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
              />
              {promoChecking ? (
                <p className="text-xs text-muted-foreground">Checking code…</p>
              ) : promoStatus && promoCode.trim() ? (
                promoStatus.valid ? (
                  <p className="text-xs text-emerald-600">✓ {promoStatus.message}</p>
                ) : (
                  <p className="text-xs text-amber-600">{promoStatus.message}</p>
                )
              ) : null}
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" onClick={() => setStep(0)}>
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={!step1Valid}>
                Continue
              </Button>
            </div>
          </form>
        )}

        {step === 2 && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (passwordOk && !passwordRejected) finish();
            }}
          >
            {askPasswordAgain && (
              <PasswordField
                id="gs-pass-again"
                label="Your password"
                value={password}
                onChange={changePassword}
                serverError={passwordRejected}
                hint={
                  <p className="break-words text-xs text-muted-foreground">
                    {passwordRejected
                      ? `Choose a different password for ${email.trim() || "your account"}. Everything else you entered is kept.`
                      : `For ${email.trim() || "your account"}. We never keep it on this device, so it is asked for again after the page reloads.`}
                  </p>
                }
              />
            )}
            <SmsOptInHeading />
            <SmsOptInFields
              phone={phone}
              onPhoneChange={setPhone}
              smsConsent={smsConsent}
              onSmsConsentChange={setSmsConsent}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex gap-2">
              {/* Once the account exists, going back to change the email or
                  password would only lead to "already has an account". */}
              <Button
                type="button"
                variant="outline"
                onClick={() => setStep(1)}
                disabled={busy || progress.current.registered}
              >
                Back
              </Button>
              <Button
                type="submit"
                className="flex-1"
                disabled={busy || !passwordOk || !!passwordRejected}
              >
                {busy
                  ? "Creating your workspace…"
                  : progress.current.registered
                    ? "Try again"
                    : "Create my workspace"}
              </Button>
            </div>
            <p className="text-center text-xs text-muted-foreground">
              Next: pick a plan (or start on the free trial).
            </p>
          </form>
        )}
      </div>
    </PublicShell>
  );
}

/**
 * The invited teammate's path through Get started (#568).
 *
 * Before this, /auth sent a new address here without the token and the page
 * asked for a business name, so the person who was invited became the owner
 * of a new, empty business and the invitation stayed pending forever. Here
 * they create an account with the invited address and join the business that
 * invited them, with the role it chose. No organization is created.
 */
function JoinTeamPage({ token }: { token: string }) {
  const navigate = useNavigate();
  const q = useQuery({
    queryKey: ["invite", token],
    queryFn: () => lookupInviteByToken({ data: { token } }),
    retry: false,
  });
  const invite = q.data?.ok && q.data.kind === "staff" ? q.data : null;

  // Prefilled from the invitation itself, not from the URL (#651).
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordRejected, setPasswordRejected] = useState<string | null>(null);

  useEffect(() => {
    rememberInviteToken(token);
  }, [token]);
  useEffect(() => {
    // The hand-off from /auth is the same address (the invitation's); drain
    // it so it does not linger in the tab.
    takeSignupEmail();
  }, []);
  useEffect(() => {
    if (invite?.email) setEmail((typed) => typed || invite.email!);
  }, [invite?.email]);

  const emailMatches = !!invite?.email && email.trim().toLowerCase() === invite.email.toLowerCase();
  const valid =
    emailMatches &&
    isPasswordAcceptable(password) &&
    !passwordRejected &&
    displayName.trim().length > 0;

  const join = async () => {
    setError(null);
    setBusy(true);
    try {
      await registerAccount({
        data: { email: email.trim(), password, displayName: displayName.trim() },
      });
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) throw signInErr;
      const joined = await acceptPendingInvite(token);
      if (!joined) {
        throw new Error(
          "Your account is created, but this invitation could not be used. Ask whoever invited you to send a new one.",
        );
      }
      // /auth sees a signed-in teammate and lands them where their role works.
      navigate({ to: "/auth" });
    } catch (err) {
      setBusy(false);
      if (isPasswordRejection(err)) {
        setPasswordRejected(passwordRejectionMessage((err as Error).message));
        return;
      }
      if (isTakenEmail(err)) return sendToSignIn(navigate, email);
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };

  return (
    <PublicShell tagline="Join your team on HoundStack." className="max-w-lg">
      <div className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Checking your invitation…</p>
        ) : !invite ? (
          <div className="space-y-3">
            <h1 className="text-lg font-semibold">This invitation can't be used</h1>
            <p className="text-sm text-muted-foreground">
              {q.data?.reason === "expired"
                ? "It has expired."
                : q.data?.reason === "revoked"
                  ? "It was cancelled."
                  : q.data?.reason === "accepted"
                    ? "It has already been used. Sign in instead."
                    : "We couldn't find it."}{" "}
              Ask whoever invited you to send a new one.
            </p>
            <Button asChild variant="outline" className="w-full">
              <Link to="/auth">Go to sign in</Link>
            </Button>
          </div>
        ) : (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (valid) join();
            }}
          >
            <div className="min-w-0">
              <h1 className="text-lg font-semibold">
                Join <bdi className="break-words">{invite.organization_name ?? "your team"}</bdi>
              </h1>
              <p className="text-sm text-muted-foreground">
                You were invited as {invite.role_label ?? humanizeRole(invite.role ?? "")}. Create
                your account to join.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="gs-email">Email</Label>
              <Input
                id="gs-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              {email.trim().length > 0 && !emailMatches && (
                <p className="text-xs text-destructive">
                  This invitation was sent to <span className="break-words">{invite.email}</span>.
                  Use that address.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="gs-name">Your name</Label>
              <Input
                id="gs-name"
                required
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Jane Doe"
                maxLength={80}
              />
            </div>
            <PasswordField
              id="gs-pass"
              value={password}
              onChange={(v) => {
                setPassword(v);
                setPasswordRejected(null);
              }}
              serverError={passwordRejected}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={!valid || busy}>
              {busy ? "Joining…" : "Create account and join"}
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              Already have an account?{" "}
              <Link to="/auth" search={{ invite: token } as never} className="underline">
                Sign in
              </Link>
            </p>
          </form>
        )}
      </div>
    </PublicShell>
  );
}
