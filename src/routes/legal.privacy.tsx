import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/legal/privacy")({
  head: () => ({
    meta: [
      { title: `Privacy Policy - ${APP_NAME}` },
      { name: "description", content: `How ${APP_NAME} collects, uses, and protects your data.` },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="July 14, 2026">
      <section>
        <p>
          {APP_NAME} ("we", "us") provides field-service software for pet-care businesses at
          app.houndstack.com. This policy explains what information we collect, how we use it, and
          the choices you have. It applies to business users of {APP_NAME} and, where noted, to
          their customers whose information those businesses store in the platform.
        </p>
      </section>

      <section>
        <h2>Information we collect</h2>
        <ul>
          <li>
            <strong>Account information:</strong> your name, email address, password (stored
            hashed), business name, and, if you choose to provide it, a mobile phone number and
            texting consent.
          </li>
          <li>
            <strong>Business data you store:</strong> client records, properties, pets, schedules,
            visits, photos, invoices, messages, and related operational data your business enters
            into the platform. Your business owns this data; we process it to run the service.
          </li>
          <li>
            <strong>Payment information:</strong> payments are processed by Stripe. We never see or
            store full card numbers; we keep references (such as card brand and last four digits)
            that Stripe provides.
          </li>
          <li>
            <strong>Usage and device information:</strong> log data, browser type, and similar
            technical information used to keep the service secure and reliable. We use cookies and
            similar storage only for sign-in sessions and app functionality, not for advertising.
          </li>
        </ul>
      </section>

      <section>
        <h2>How we use information</h2>
        <ul>
          <li>To provide, maintain, and improve the service.</li>
          <li>To authenticate sign-ins and secure accounts.</li>
          <li>
            To send communications you request or that are essential to the service: login codes,
            visit and billing notifications, and account notices.
          </li>
          <li>To provide support and respond to requests.</li>
          <li>To comply with legal obligations.</li>
        </ul>
        <p>We do not sell personal information. We do not use your data for advertising.</p>
      </section>

      <section>
        <h2>Text messaging</h2>
        <p>
          Text messages are only sent with prior consent, and every message includes opt-out
          instructions (reply STOP). <strong>No mobile information will be shared with third
          parties or affiliates for marketing or promotional purposes.</strong> Text messaging
          originator opt-in data and consent are not shared with any third parties, except with our
          SMS delivery provider solely to deliver the messages you asked for. See the{" "}
          <a href="/legal/sms">SMS Consent &amp; Messaging Policy</a> for details.
        </p>
      </section>

      <section>
        <h2>Who we share information with</h2>
        <p>
          We share data only with the service providers needed to run {APP_NAME}, under contracts
          that limit their use of it:
        </p>
        <ul>
          <li>Supabase (database, authentication, and file storage)</li>
          <li>Stripe (payment processing and billing)</li>
          <li>Twilio (SMS delivery)</li>
          <li>Resend (email delivery)</li>
          <li>Cloud hosting and infrastructure providers</li>
        </ul>
        <p>
          We may also disclose information if required by law, or as part of a business transfer
          (in which case this policy continues to apply).
        </p>
      </section>

      <section>
        <h2>Data retention and deletion</h2>
        <p>
          We keep your data while your account is active. You can request deletion of your account
          and its data by emailing{" "}
          <a href="mailto:support@houndstack.com">support@houndstack.com</a>; we delete or
          anonymize it within a reasonable period, except where the law requires longer retention
          (for example, billing records).
        </p>
      </section>

      <section>
        <h2>Security</h2>
        <p>
          Data is encrypted in transit, access is restricted by role-based controls and row-level
          security, and payment credentials never touch our servers. No system is perfectly secure,
          but we design for least access and defense in depth.
        </p>
      </section>

      <section>
        <h2>Your rights</h2>
        <p>
          Depending on where you live, you may have the right to access, correct, export, or delete
          your personal information, or to object to certain processing. Contact us at{" "}
          <a href="mailto:support@houndstack.com">support@houndstack.com</a> and we will honor
          applicable requests. If you are a customer of a business that uses {APP_NAME}, that
          business controls your records; contact them directly and we will support their
          fulfillment of your request.
        </p>
      </section>

      <section>
        <h2>Children</h2>
        <p>
          {APP_NAME} is a business tool and is not directed to children under 13. We do not
          knowingly collect information from children.
        </p>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>
          We will post any changes to this policy on this page and update the date above. Questions:{" "}
          <a href="mailto:support@houndstack.com">support@houndstack.com</a>.
        </p>
      </section>
    </LegalShell>
  );
}
