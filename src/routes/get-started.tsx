import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { bootstrapOrganization, recordSmsConsent } from "@/lib/org.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/Logo";
import { APP_NAME } from "@/lib/scoop";

// The Get-started walkthrough (Brendan's re-review): account creation is a
// guided path, not a tab on the sign-in card. Steps: account → business →
// texting consent (Twilio/TCPA compliance) → then straight into /onboarding
// for the plan picker + embedded payment, one continuous flow.
export const Route = createFileRoute("/get-started")({
  // The identifier-first /auth screen hands new emails over via ?email=…
  validateSearch: (s: Record<string, unknown>) => ({
    email: typeof s.email === "string" ? s.email : undefined,
  }),
  head: () => ({
    meta: [
      { title: `Get started — ${APP_NAME}` },
      { name: "description", content: `Create your ${APP_NAME} workspace.` },
    ],
  }),
  component: GetStartedPage,
});

// The exact consent language stored alongside the timestamp — carrier/TCPA
// express-consent elements: who texts, what kind, frequency varies, rates
// disclosure, STOP/HELP, and not-a-condition-of-purchase.
export const SMS_CONSENT_TEXT =
  `I agree to receive text messages from ${APP_NAME} at the number provided, ` +
  `including login codes and service notifications. Message frequency varies. ` +
  `Message & data rates may apply. Reply STOP to opt out or HELP for help. ` +
  `Consent is not a condition of purchase.`;

const STEPS = ["Your account", "Your business", "Texting"] as const;

function GetStartedPage() {
  const navigate = useNavigate();
  const { email: emailFromAuth } = Route.useSearch();
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [email, setEmail] = useState(emailFromAuth ?? "");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [phone, setPhone] = useState("");
  const [smsConsent, setSmsConsent] = useState(false);

  const step0Valid = /.+@.+\..+/.test(email) && password.length >= 8;
  const step1Valid = orgName.trim().length > 0 && displayName.trim().length > 0;

  const finish = async () => {
    setError(null);
    setBusy(true);
    try {
      const { error: signUpErr } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: window.location.origin,
          data: {
            org_name: orgName,
            display_name: displayName,
            phone: phone || undefined,
            sms_consent: smsConsent && phone ? true : undefined,
          },
        },
      });
      if (signUpErr) throw signUpErr;

      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        // Email confirmation required — consent metadata rides along and is
        // applied when they first sign in (ensureBootstrapped).
        setBusy(false);
        setError("Check your email to confirm your account, then sign in — your setup continues from there.");
        return;
      }

      await bootstrapOrganization({ data: { orgName, displayName } });
      if (smsConsent && phone.trim()) {
        try {
          await recordSmsConsent({ data: { phone: phone.trim(), consentText: SMS_CONSENT_TEXT } });
        } catch (e) {
          console.error("sms consent record failed", e);
        }
      }
      navigate({ to: "/onboarding" });
    } catch (err) {
      setBusy(false);
      setError(err instanceof Error ? err.message : "Something went wrong — try again.");
    }
  };

  return (
    <div className="flex min-h-screen items-start justify-center bg-background px-4 py-10 sm:items-center">
      <div className="w-full max-w-lg space-y-6">
        <div className="flex flex-col items-center text-center">
          <Logo variant="logo" className="h-12 w-auto text-primary" />
          <p className="mt-2 text-sm text-muted-foreground">
            Let's set up your workspace — about two minutes.
          </p>
        </div>

        <div className="flex items-center gap-2">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-1 items-center gap-2">
              <div
                className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                  i <= step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
                }`}
              >
                {i < step ? "✓" : i + 1}
              </div>
              <span className={`text-xs sm:text-sm ${i === step ? "font-medium" : "text-muted-foreground"}`}>
                {label}
              </span>
              {i < STEPS.length - 1 && <div className="h-px flex-1 bg-border" />}
            </div>
          ))}
        </div>

        <div className="rounded-xl border bg-card p-6 shadow-sm">
          {step === 0 && (
            <form
              className="space-y-4"
              onSubmit={(e) => { e.preventDefault(); if (step0Valid) setStep(1); }}
            >
              <div>
                <h1 className="text-lg font-semibold">Create your account</h1>
                <p className="text-sm text-muted-foreground">You'll use this to sign in.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gs-email">Work email</Label>
                <Input id="gs-email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@yourbusiness.com" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gs-pass">Password</Label>
                <Input id="gs-pass" type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" />
              </div>
              <Button type="submit" className="w-full" disabled={!step0Valid}>Continue</Button>
              <p className="text-center text-xs text-muted-foreground">
                Already have an account? <Link to="/auth" className="underline">Sign in</Link>
              </p>
            </form>
          )}

          {step === 1 && (
            <form
              className="space-y-4"
              onSubmit={(e) => { e.preventDefault(); if (step1Valid) setStep(2); }}
            >
              <div>
                <h1 className="text-lg font-semibold">About your business</h1>
                <p className="text-sm text-muted-foreground">This names your workspace — you can change it later.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gs-org">Business name</Label>
                <Input id="gs-org" required value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Pet Waste Removal" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="gs-name">Your name</Label>
                <Input id="gs-name" required value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Jane Doe" />
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setStep(0)}>Back</Button>
                <Button type="submit" className="flex-1" disabled={!step1Valid}>Continue</Button>
              </div>
            </form>
          )}

          {step === 2 && (
            <form
              className="space-y-4"
              onSubmit={(e) => { e.preventDefault(); finish(); }}
            >
              <div>
                <h1 className="text-lg font-semibold">Stay in the loop by text</h1>
                <p className="text-sm text-muted-foreground">
                  Optional — used for login codes and important account notifications.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="gs-phone">Mobile number <span className="font-normal text-muted-foreground">(optional)</span></Label>
                <Input id="gs-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(555) 123-4567" />
              </div>
              {/* TCPA/carrier express consent: unticked by default, full
                  disclosure language, and we store exactly what was agreed to. */}
              <label className={`flex items-start gap-2 rounded-md border p-3 text-xs leading-relaxed ${phone.trim() ? "" : "opacity-50"}`}>
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={smsConsent}
                  disabled={!phone.trim()}
                  onChange={(e) => setSmsConsent(e.target.checked)}
                />
                <span>{SMS_CONSENT_TEXT}</span>
              </label>
              {error && <p className="text-sm text-destructive">{error}</p>}
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={() => setStep(1)} disabled={busy}>Back</Button>
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
      </div>
    </div>
  );
}
