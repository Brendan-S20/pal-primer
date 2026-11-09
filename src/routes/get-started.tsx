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
  registerAccount,
  sendEmailVerification,
} from "@/lib/auth-entry.functions";
import { lookupInviteByToken } from "@/lib/platform-onboarding.functions";
import { acceptPendingInvite, rememberInviteToken } from "@/lib/ensure-workspace";
import { humanizeRole } from "@/lib/humanize";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicShell } from "@/components/PublicShell";
import { SMS_CONSENT_TEXT, SmsOptInFields, SmsOptInHeading } from "@/components/SmsOptInFields";
import { APP_NAME } from "@/lib/scoop";
import { isValidOrgName } from "@/lib/dna-linkage";
import { pageTitle } from "@/lib/page-title";
import { deviceTimezone } from "@/lib/org-timezone";
import { handOffSignupEmail, takeSignupEmail } from "@/lib/signup-email";
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
  // Drawn again partway through, with no password to hand (it is never kept):
  // the last step asks for it once more (#785 (a)).
  const [askPasswordAgain, setAskPasswordAgain] = useState(false);
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

  const step0Valid = /.+@.+\..+/.test(email) && password.length >= 8;

  const continueFromAccount = async () => {
    setError(null);
    setChecking(true);
    try {
      const r = await checkEmailAccount({ data: { email: email.trim() } });
      if (r.exists) {
        setError("That email already has an account. Sign in instead.");
        return;
      }
      if (r.pendingInvite) {
        setInvited(true);
        return;
      }
    } catch {
      // The check is a courtesy. finish() still joins a pending invitation
      // before it would build anything.
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
              if (displayName.trim()) join();
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
                }}
                disabled={busy}
              >
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={!displayName.trim() || busy}>
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
      // Frictionless signup: the account is created server-side auto-confirmed
      // so there's no email-confirmation wall. Verifying the address is a
      // to-do afterwards (and gates Stripe Express until done).
      await registerAccount({
        data: {
          email: email.trim(),
          password,
          orgName: orgName.trim(),
          displayName: displayName.trim(),
          phone: phone.trim() || undefined,
          smsConsent: smsConsent && !!phone.trim(),
        },
      });
      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInErr) throw signInErr;

      // Invited without the link (opened the app and signed up directly): the
      // email path still finds the invitation, and joining it is the right
      // answer rather than a second business under the same address (#568).
      if (await acceptPendingInvite(null)) {
        clearSignupAttribution();
        clearSignupDraft();
        navigate({ to: "/auth" });
        return;
      }

      const attribution = readSignupAttribution();
      const boot = await bootstrapOrganization({
        data: {
          orgName,
          displayName,
          refCode: attribution.ref,
          utm: attribution.utm,
          serviceLine: attribution.service,
          promoCode: promoCode.trim() || undefined,
          // The phone's or browser's zone. Without it the org kept the
          // column default, Central, on every signup (#654).
          timezone: deviceTimezone(),
        },
      });
      clearSignupAttribution();

      // The code was checked on blur and this form TOLD them it was good. If
      // keeping it then failed, nothing downstream can warn them: the org
      // carries no code, so the subscribe screen cannot tell "lost it" from
      // "never had one" and will quietly charge full price.
      //
      // Signup is not blocked and the account is already created -- losing a
      // discount is not worth losing a customer over. But this is the last
      // moment anybody can say so, so it is said here and held on screen.
      // `promoStored` is null when there was no coupon to keep, which is the
      // ordinary case and says nothing.
      if (boot?.promoStored === false) {
        toast.warning(
          `We could not attach promo code ${promoCode.trim()} to your account. Your account is set up. Contact us before you subscribe so we can apply it.`,
          { duration: 15000 },
        );
      }
      if (smsConsent && phone.trim()) {
        try {
          await recordSmsConsent({ data: { phone: phone.trim(), consentText: SMS_CONSENT_TEXT } });
        } catch (e) {
          console.error("sms consent record failed", e);
        }
      }
      // Fire the verification email in the background — verify now or later.
      try {
        await sendEmailVerification();
      } catch (e) {
        console.error("verification email send failed", e);
      }
      clearSignupDraft();
      navigate({ to: "/onboarding" });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
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
              if (step0Valid && !checking) void continueFromAccount();
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
            <div className="space-y-2">
              <Label htmlFor="gs-pass">Password</Label>
              <Input
                id="gs-pass"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </div>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" className="w-full" disabled={!step0Valid || checking}>
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
              finish();
            }}
          >
            {askPasswordAgain && (
              <div className="space-y-2">
                <Label htmlFor="gs-pass-again">Your password</Label>
                <Input
                  id="gs-pass-again"
                  type="password"
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
                <p className="break-words text-xs text-muted-foreground">
                  For {email.trim() || "your account"}. We never keep it on this device, so it is
                  asked for again after the page reloads.
                </p>
              </div>
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
              <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={busy}>
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={busy || password.length < 8}>
                {busy ? "Creating your workspace…" : "Create my workspace"}
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
  const valid = emailMatches && password.length >= 8 && displayName.trim().length > 0;

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
            <div className="space-y-2">
              <Label htmlFor="gs-pass">Password</Label>
              <Input
                id="gs-pass"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </div>
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
