import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  clearSignupAttribution,
  readSignupAttribution,
  stashSignupAttribution,
  stashSignupPromoCode,
} from "@/lib/signup-attribution";
import { supabase } from "@/integrations/supabase/client";
import { bootstrapOrganization, recordSmsConsent, validateSignupCode } from "@/lib/org.functions";
import { registerAccount, sendEmailVerification } from "@/lib/auth-entry.functions";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PublicShell } from "@/components/PublicShell";
import { SMS_CONSENT_TEXT, SmsOptInFields, SmsOptInHeading } from "@/components/SmsOptInFields";
import { APP_NAME } from "@/lib/scoop";
import { isValidOrgName } from "@/lib/dna-linkage";
import { pageTitle } from "@/lib/page-title";

// The Get-started walkthrough (Brendan's re-review): account creation is a
// guided path, not a tab on the sign-in card. Steps: account → business →
// texting consent (Twilio/TCPA compliance) → then straight into /onboarding
// for the plan picker + embedded payment, one continuous flow.
export const Route = createFileRoute("/get-started")({
  // The identifier-first /auth screen hands new emails over via ?email=…
  // ref/utm_* also land here directly when a marketing link skips /sign-up.
  validateSearch: (s: Record<string, unknown>) => ({
    email: typeof s.email === "string" ? s.email : undefined,
    ref: typeof s.ref === "string" ? s.ref : undefined,
    utm_source: typeof s.utm_source === "string" ? s.utm_source : undefined,
    utm_medium: typeof s.utm_medium === "string" ? s.utm_medium : undefined,
    utm_campaign: typeof s.utm_campaign === "string" ? s.utm_campaign : undefined,
    utm_term: typeof s.utm_term === "string" ? s.utm_term : undefined,
    utm_content: typeof s.utm_content === "string" ? s.utm_content : undefined,
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
  const navigate = useNavigate();
  const search = Route.useSearch();
  const { email: emailFromAuth } = search;
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState(emailFromAuth ?? "");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);

  // "Promo or referral code" (optional). Validated server-side for a friendly
  // hint, but an invalid code NEVER blocks signup — the server drops bad codes
  // at org creation anyway.
  const [promoCode, setPromoCode] = useState("");
  const [promoStatus, setPromoStatus] = useState<{ valid: boolean; message: string } | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

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

      const attribution = readSignupAttribution();
      const boot = await bootstrapOrganization({
        data: {
          orgName,
          displayName,
          refCode: attribution.ref,
          utm: attribution.utm,
          promoCode: promoCode.trim() || undefined,
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
      navigate({ to: "/onboarding" });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    }
  };

  return (
    <PublicShell tagline="Set up your workspace in about two minutes." className="max-w-lg">
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

        <div className="rounded-xl border bg-card p-(--card-pad) shadow-sm">
          {step === 0 && (
            <form
              className="space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (step0Valid) setStep(1);
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
              <Button type="submit" className="w-full" disabled={!step0Valid}>
                Continue
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
                <Button type="submit" className="flex-1" disabled={busy}>
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
