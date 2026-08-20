import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";
import { APP_NAME } from "@/lib/scoop";

// Public SMS program disclosure for Twilio toll-free verification and TCPA
// compliance. Describes the app's real behavior: express opt-in at signup
// (organizations.sms_consent_*), STOP handling (clients.sms_opt_out), and the
// message types the platform actually sends.
export const Route = createFileRoute("/legal/sms")({
  head: () => ({
    meta: [
      { title: `SMS Consent & Messaging Policy - ${APP_NAME}` },
      {
        name: "description",
        content: `How ${APP_NAME} collects consent for text messages, what we send, and how to opt out.`,
      },
    ],
  }),
  component: SmsPolicyPage,
});

function SmsPolicyPage() {
  return (
    <LegalShell title="SMS Consent & Messaging Policy" updated="August 20, 2026">
      <section>
        <h2>The short version</h2>
        <p>
          {APP_NAME} only sends text messages to people who ask for them, and every message we send
          includes a way to stop. Reply <strong>STOP</strong> to any message to opt out immediately,
          or <strong>HELP</strong> for assistance.
        </p>
      </section>

      <section>
        <h2>Consent is separate from every other agreement</h2>
        <p>
          Consent to receive text messages from {APP_NAME} is collected on its own, by its own
          affirmative action, and is <strong>never</strong> given by accepting any other agreement.
        </p>
        <ul>
          <li>
            Accepting our <a href="/legal/terms">Terms of Service</a> does not give consent to
            receive text messages.
          </li>
          <li>
            Accepting our <a href="/legal/privacy">Privacy Policy</a> does not give consent to
            receive text messages.
          </li>
          <li>
            Creating an account, subscribing to a plan, paying an invoice or using any part of{" "}
            {APP_NAME} does not give consent to receive text messages.
          </li>
        </ul>
        <p>
          The only way consent is given is by separately ticking an unticked box, or turning on a
          switch that is off by default, whose words are shown in full at the moment of the choice
          and stored with the timestamp. Declining, or withdrawing consent later, changes nothing
          about your account, your plan, your price or your access to {APP_NAME}.
        </p>
      </section>

      <section>
        <h2>What messages we send</h2>
        <p>{APP_NAME} sends two kinds of text messages, and both require prior consent:</p>
        <ul>
          <li>
            <strong>Account messages to business users.</strong> If you create a {APP_NAME} account
            and choose to give us a mobile number, we may text you account and service
            notifications. This is optional: {APP_NAME} accounts sign in with an email address and
            password, so you never need to receive a text to create, access or use your account.
          </li>
          <li>
            <strong>Service messages to a business's customers.</strong> Pet-care businesses that
            run on {APP_NAME} can text their own customers things like visit reminders,
            "your technician is on the way" notices, visit-completed confirmations, portal sign-in
            codes, overdue-invoice reminders, and review requests. These messages are sent only to
            customers who gave that business their number and consent to be contacted.
          </li>
        </ul>
        <p>
          We do not send marketing or promotional cold texts, and we never text numbers that have
          not opted in.
        </p>
      </section>

      <section>
        <h2>How consent is collected</h2>
        <p>
          Business users may opt in on the last step of account creation by entering a mobile number
          and ticking a consent box that is unticked by default. Both the number and the box are
          optional, and the account is created whether or not they are filled in. The box carries
          this language:
        </p>
        <p className="rounded-md border bg-muted/40 p-3 text-sm">
          "I agree to receive text messages from {APP_NAME} at the number provided about my account
          and service notifications. Consent is optional and is not a condition of purchase — you
          can create and use a {APP_NAME} account without it. Message frequency varies. Message
          &amp; data rates may apply. Reply STOP to opt out or HELP for help."
        </p>
        <p>
          We record when consent was given, the number it covers, and the exact language shown.
          Businesses using {APP_NAME} to message their customers are responsible for collecting
          equivalent consent from those customers, and the platform enforces opt-outs for them
          automatically.
        </p>
      </section>

      <section>
        <h2>Screenshots of the opt-in flow</h2>
        <p>
          The sign-up journey as a new customer sees it, captured in order and unedited. Published
          here so the flow described above can be checked against the flow that actually runs.
        </p>
        <ul>
          <li><a href="/sms-opt-in/1-account.png">Step 1 — your account</a> (no phone number requested)</li>
          <li><a href="/sms-opt-in/2-business.png">Step 2 — your business</a> (no phone number requested)</li>
          <li><a href="/sms-opt-in/3-finish-no-number.png">Step 3 — finish</a>, before any number is entered</li>
          <li><a href="/sms-opt-in/4-opt-in-unticked.png">The opt-in, unticked</a> — the account can be created from here as it stands</li>
          <li><a href="/sms-opt-in/5-opt-in-ticked.png">The opt-in, ticked</a> — consent given by this separate action alone</li>
        </ul>
        <p>And the same carve-out in each of the three agreements:</p>
        <ul>
          <li><a href="/sms-opt-in/6-sms-policy.png">This policy</a></li>
          <li><a href="/sms-opt-in/7-terms.png">Terms of Service</a></li>
          <li><a href="/sms-opt-in/8-privacy.png">Privacy Policy</a></li>
        </ul>
      </section>

      <section>
        <h2>Message frequency and rates</h2>
        <p>
          Message frequency varies based on your account activity and service schedule. Message and
          data rates may apply according to your mobile carrier's plan. Consent to receive texts is
          never a condition of purchasing any product or service.
        </p>
      </section>

      <section id="opt-out">
        <h2>How to opt out (SMS un-consent)</h2>
        <ul>
          <li>
            <strong>Reply STOP</strong> to any message you receive from {APP_NAME} or from a
            business using {APP_NAME}. Opt-outs take effect immediately and are enforced
            automatically: the platform blocks further texts to your number.
          </li>
          <li>
            Reply <strong>HELP</strong> to any message for assistance.
          </li>
          <li>
            Business users can also remove their mobile number or withdraw texting consent in
            Settings, and customers of a {APP_NAME} business can manage notification preferences in
            their client portal or by contacting the business directly.
          </li>
          <li>
            You can always email <a href="mailto:support@houndstack.com">support@houndstack.com</a>{" "}
            and we will process the opt-out for you.
          </li>
        </ul>
      </section>

      <section>
        <h2>Privacy of your mobile information</h2>
        <p>
          No mobile information will be shared with third parties or affiliates for marketing or
          promotional purposes. Text messaging originator opt-in data and consent are not shared
          with any third parties, except with our SMS delivery provider solely to send the messages
          you asked for. See our <a href="/legal/privacy">Privacy Policy</a> for full details.
        </p>
      </section>

      <section>
        <h2>Carriers</h2>
        <p>
          Messages are delivered over the networks of participating carriers. Carriers are not
          liable for delayed or undelivered messages.
        </p>
      </section>

      <section>
        <h2>Contact</h2>
        <p>
          Questions about this policy: <a href="mailto:support@houndstack.com">support@houndstack.com</a>.
        </p>
      </section>
    </LegalShell>
  );
}
