import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { APP_NAME } from "@/lib/scoop";

// The exact consent language stored alongside the timestamp — carrier/TCPA
// express-consent elements: who texts, what kind, frequency varies, rates
// disclosure, STOP/HELP, and not-a-condition-of-purchase.
//
// It used to say "including login codes and service notifications", and both
// halves of that were a problem. LOGIN CODES ARE NOT SENT TO BUSINESS USERS AT
// ALL: org auth is email/password plus EMAIL otp, and the only SMS send path in
// this repo is `sendSmsToClient`, which texts a tenant's own customers. So the
// sentence promised messages that are never sent — and, worse, told the person
// ticking it that agreeing to texts was how they would get into their account.
// That is "messaging consent as a condition of using the service", which is the
// exact ground Twilio rejected the toll-free verification on (error 30475).
//
// The optionality is now stated inside the consent record itself rather than
// only in the surrounding UI, because the stored text is what a carrier reads
// back months later, long after the page around it has changed.
// This is the single source for the signup step 3 box and /legal/sms-opt-in.
// Keep this wording identical to /legal/sms, the resubmission document, and
// the opt-in evidence screenshots. It is stored with each consent record.
export const SMS_CONSENT_TEXT =
  `I agree to receive text messages from ${APP_NAME} at the number provided about my ` +
  `account and service notifications, including verification codes, security alerts and ` +
  `billing notices. Consent is optional and is not a condition of purchase. You can ` +
  `create and use a ${APP_NAME} account without it. Message frequency varies. Msg & ` +
  `data rates may apply. Reply STOP to opt out, HELP for help.`;

// The heading of the last signup step, shared for the same reason.
export function SmsOptInHeading() {
  return (
    <div>
      <h1 className="text-lg font-semibold">Create your workspace</h1>
      <p className="text-sm text-muted-foreground">
        You can add a mobile number for account notifications by text. This is entirely optional.
        Skip it and your workspace is created just the same.
      </p>
    </div>
  );
}

// The opt-in block from the last step of /get-started: optional number, the
// unticked consent box and the policy links. Shared with /legal/sms-opt-in so
// the public evidence page cannot drift from the live signup step (#451).
// It holds no data of its own; the parent owns state and decides what, if
// anything, is submitted.
export function SmsOptInFields({
  phone,
  onPhoneChange,
  smsConsent,
  onSmsConsentChange,
}: {
  phone: string;
  onPhoneChange: (value: string) => void;
  smsConsent: boolean;
  onSmsConsentChange: (checked: boolean) => void;
}) {
  return (
    <>
      <div className="space-y-2">
        <Label htmlFor="gs-phone">
          Mobile number <span className="font-normal text-muted-foreground">(optional)</span>
        </Label>
        <Input
          id="gs-phone"
          type="tel"
          value={phone}
          onChange={(e) => onPhoneChange(e.target.value)}
          placeholder="(555) 123-4567"
        />
      </div>
      {/* TCPA/carrier express consent: unticked by default, full
          disclosure language, and we store exactly what was agreed to.
          The line above the box says the quiet part out loud. A reviewer
          walking this flow has to be able to see, without reading the
          fine print, that declining changes nothing about the account
          they are about to create. */}
      <p className="text-xs font-medium text-muted-foreground">
        Optional. You do not have to agree to texts to create an account or use {APP_NAME}.
      </p>
      <label
        className={`flex items-start gap-2 rounded-md border p-3 text-xs leading-relaxed ${phone.trim() ? "" : "opacity-50"}`}
      >
        <input
          type="checkbox"
          className="mt-0.5"
          checked={smsConsent}
          disabled={!phone.trim()}
          onChange={(e) => onSmsConsentChange(e.target.checked)}
        />
        <span>{SMS_CONSENT_TEXT}</span>
      </label>
      {/* Twilio's toll-free review asks for the Privacy Policy and Terms
          on the same screen as the opt-in, not only in the footer
          (#396). A new tab, so following one does not throw away the
          form the person has half filled in. */}
      <p className="text-xs text-muted-foreground">
        See our{" "}
        <a href="/legal/privacy" target="_blank" rel="noopener" className="underline">
          Privacy Policy
        </a>
        ,{" "}
        <a href="/legal/terms" target="_blank" rel="noopener" className="underline">
          Terms of Service
        </a>{" "}
        and{" "}
        <a href="/legal/sms" target="_blank" rel="noopener" className="underline">
          SMS Consent &amp; Messaging Policy
        </a>
        .
      </p>
    </>
  );
}
