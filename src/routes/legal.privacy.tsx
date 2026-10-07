import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";
import { APP_NAME } from "@/lib/scoop";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/legal/privacy")({
  head: () => ({
    meta: [
      { title: pageTitle("Privacy Policy") },
      { name: "description", content: `How ${APP_NAME} collects, uses, and protects your data.` },
    ],
  }),
  component: PrivacyPage,
});

function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="October 7, 2026">
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
            <strong>Location of field staff:</strong> when a technician uses the app to navigate or
            view a route map, the device's location is used on the device to show where they are. If
            a business turns on live tracking, a technician's approximate location (rounded to about
            100 meters) is sent to us while they are on the way to a customer, from the &ldquo;on my
            way&rdquo; message until they start that visit, for at most two hours, and only while
            the app is open. Only the latest position is kept, and it is deleted when the visit
            starts. Live tracking is off unless the business turns it on, and the technician can
            stop it at any time.
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
            To send communications you request or that are essential to the service: sign-in emails,
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
          <strong>Text messaging is coming soon and is pending carrier registration.</strong>
        </p>
        <p>
          We collect mobile numbers and SMS consent records only from {APP_NAME} account holders who
          opt in. When you opt in we store the number, the exact consent wording you agreed to, and
          the time you agreed. Account holders who opt in may receive verification codes, security
          alerts, billing notices and support replies by text from {APP_NAME}. We do not use these
          messages for marketing.
        </p>
        <p>
          <strong>
            Mobile numbers and SMS consent records are not shared with or sold to third parties or
            affiliates for marketing or promotional purposes.
          </strong>{" "}
          The only party that receives them is our SMS delivery provider, and only to deliver the
          messages you asked for. See the{" "}
          <a href="/legal/sms">SMS Consent &amp; Messaging Policy</a> for details.
        </p>
        <p>
          <strong>STOP and HELP.</strong> Reply STOP to any text from {APP_NAME} to opt out. The
          opt-out takes effect immediately, we send one confirmation, and no further texts are sent
          to that number. Reply HELP for help, or email{" "}
          <a href="mailto:support@houndstack.com">support@houndstack.com</a>. You can also remove
          your number or withdraw consent in Settings.
        </p>
        <p>
          <strong>Accepting this policy does not give consent to receive text messages.</strong>{" "}
          Messaging consent is separate and optional, is collected by its own affirmative action,
          and is never a condition of creating an account or using {APP_NAME}. You can decline it,
          or withdraw it at any time by replying STOP, without any effect on your account.
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
          <li>Google (maps and address suggestions)</li>
          <li>Geocodio (turning addresses into map locations)</li>
          <li>
            Anthropic (the AI features, once a business switches them on: the AI receptionist and
            drafting marketing posts)
          </li>
          <li>Cloud hosting and infrastructure providers</li>
        </ul>
        <p>
          When a business turns on its AI receptionist (coming soon), the text of messages and calls
          to that business&apos;s own number, with the recent conversation, is sent to the AI
          provider to write the reply. The receptionist says it is an automated assistant. It never
          uses {APP_NAME}&apos;s own number, which only ever texts {APP_NAME} account holders.
        </p>
        <p>
          A business can also choose to connect other services, such as its accounting software or
          an automation tool through a webhook. When it does, the data it chose to send goes to that
          service on the business&apos;s instruction.
        </p>
        <p>
          When a business turns on live tracking, the customer who received the &ldquo;on my
          way&rdquo; message can see the technician&apos;s first name and approximate location on a
          map until the technician arrives.
        </p>
        <p>
          We may also disclose information if required by law, or as part of a business transfer (in
          which case this policy continues to apply).
        </p>
      </section>

      <section>
        <h2>Data retention and deletion</h2>
        <p>
          We keep your data while your account is active. You can delete your account yourself, from
          inside the app: open your profile and choose <strong>Delete my account</strong>. Deleting
          removes your sign-in and access, and anonymizes your personal details.
        </p>
        <p>
          Business records such as invoices, payments, service history, and audit logs may be
          retained where required for legal and accounting purposes. If you are the only owner of a
          workspace, you will be asked to transfer ownership or close the workspace first, so that
          the business is not left without an administrator.
        </p>
        <p>
          If you would rather we did it for you, or you can no longer sign in, email{" "}
          <a href="mailto:support@houndstack.com">support@houndstack.com</a>.
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
