// The last step of Get started, as a sequence that can be resumed.
//
// ── WHAT WAS WRONG (Detroit Doo Disposal onboarding, 2026-11-09) ───────────
//
// "Create my workspace" did four things in a row: create the account, sign
// in, build the business, record the texting consent. Two faults:
//
//   1. A failure after the account existed left the page offering the same
//      button, which then called registerAccount again and was told "That
//      email already has an account". A person with an account, no business,
//      and no way forward from the screen in front of them.
//   2. The texting consent was recorded best-effort: a failure went to
//      console.error and the page moved on to /onboarding, so the record the
//      business is required to keep, and was told it was keeping, was lost.
//
// So each step is marked done on `progress` as it lands, a retry starts from
// the first one that has not, and a failed consent stops here like any other
// failed save. The verification email stays best-effort: it is not a setting.

export type SignupForm = {
  email: string;
  password: string;
  orgName: string;
  displayName: string;
  phone: string;
  smsConsent: boolean;
  promoCode: string;
};

export type SignupProgress = { registered: boolean; bootstrapped: boolean; consentSaved: boolean };

export const newSignupProgress = (): SignupProgress => ({
  registered: false,
  bootstrapped: false,
  consentSaved: false,
});

export type SignupDeps = {
  registerAccount: (a: { data: Record<string, unknown> }) => Promise<unknown>;
  signIn: (email: string, password: string) => Promise<{ error: unknown }>;
  acceptPendingInvite: () => Promise<unknown>;
  bootstrapOrganization: (a: {
    data: Record<string, unknown>;
  }) => Promise<{ promoStored?: boolean | null } | null | undefined>;
  recordSmsConsent: (a: { data: { phone: string; consentText: string } }) => Promise<unknown>;
  sendEmailVerification: () => Promise<unknown>;
  readAttribution: () => { ref?: string; utm?: Record<string, string>; service?: string };
  clearAttribution: () => void;
  timezone: () => string | undefined;
  consentText: string;
  onPromoLost: (code: string) => void;
  /** Told how the verification email went, once it has gone (#786). The send
   *  is not awaited, so `finishSignup` returns before this is called: a caller
   *  that wants to say "we sent a link" or "we could not" says it from here,
   *  not from a flag read after `await finishSignup(...)`, which would always
   *  still be unset. Never called for "joined-team", where nothing is sent. */
  onVerificationSettled?: (sent: boolean) => void;
};

export type SignupOutcome = "joined-team" | "workspace";

export async function finishSignup(
  form: SignupForm,
  progress: SignupProgress,
  deps: SignupDeps,
): Promise<SignupOutcome> {
  const email = form.email.trim();
  const phone = form.phone.trim();

  if (!progress.registered) {
    // Frictionless signup: the account is created server-side auto-confirmed
    // so there's no email-confirmation wall. Verifying the address is a to-do
    // afterwards (and gates Stripe Express until done).
    await deps.registerAccount({
      data: {
        email,
        password: form.password,
        orgName: form.orgName.trim(),
        displayName: form.displayName.trim(),
        phone: phone || undefined,
        smsConsent: form.smsConsent && !!phone,
      },
    });
    const { error } = await deps.signIn(email, form.password);
    if (error) throw error;
    progress.registered = true;
  }

  if (!progress.bootstrapped) {
    // Invited without the link (opened the app and signed up directly): the
    // email path still finds the invitation, and joining it is the right
    // answer rather than a second business under the same address (#568).
    if (await deps.acceptPendingInvite()) {
      deps.clearAttribution();
      return "joined-team";
    }
    const attribution = deps.readAttribution();
    const boot = await deps.bootstrapOrganization({
      data: {
        orgName: form.orgName,
        displayName: form.displayName,
        refCode: attribution.ref,
        utm: attribution.utm,
        serviceLine: attribution.service,
        promoCode: form.promoCode.trim() || undefined,
        // The phone's or browser's zone. Without it the org kept the column
        // default, Central, on every signup (#654).
        timezone: deps.timezone(),
        // Saved as the business's contact phone and the owner's own, so
        // Settings, Profile and setup step 1 show what was typed here.
        phone: phone || undefined,
      },
    });
    progress.bootstrapped = true;
    deps.clearAttribution();
    // The code was checked on blur and the form TOLD them it was good. If
    // keeping it then failed, this is the last moment anybody can say so.
    // `promoStored` is null when there was no coupon to keep.
    if (boot?.promoStored === false) deps.onPromoLost(form.promoCode.trim());
  }

  if (form.smsConsent && phone && !progress.consentSaved) {
    await deps.recordSmsConsent({ data: { phone, consentText: deps.consentText } });
    progress.consentSaved = true;
  }

  // Verify now or later; never a reason to stop -- and never a reason to
  // WAIT, either (#786). This used to be awaited, so "Create my workspace"
  // held the owner on the button for as long as the mail provider took to
  // answer, after the business already existed: part of the 4.3 s measured
  // on live. The send is started here and left to finish on its own; a
  // failure is still logged, and nothing about it can stop the signup.
  // The result is handed to onVerificationSettled when it arrives.
  void Promise.resolve()
    .then(() => deps.sendEmailVerification())
    .then(
      () => deps.onVerificationSettled?.(true),
      (e) => {
        console.error("verification email send failed", e);
        deps.onVerificationSettled?.(false);
      },
    )
    .catch((e) => console.error("reporting the verification email failed", e));
  return "workspace";
}

/** What the screen says when a step failed, given how far it got. */
export function signupErrorMessage(err: unknown, progress: SignupProgress): string {
  const message = err instanceof Error ? err.message : "Something went wrong. Try again.";
  return progress.registered
    ? `Your account is created, but setup did not finish: ${message} Press Try again to finish it.`
    : message;
}
