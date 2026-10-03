import { createFileRoute } from "@tanstack/react-router";
import { LegalShell } from "@/components/LegalShell";
import { APP_NAME } from "@/lib/scoop";
import { pageTitle } from "@/lib/page-title";

export const Route = createFileRoute("/legal/terms")({
  head: () => ({
    meta: [
      { title: pageTitle("Terms of Service") },
      { name: "description", content: `The terms that govern your use of ${APP_NAME}.` },
    ],
  }),
  component: TermsPage,
});

function TermsPage() {
  return (
    <LegalShell title="Terms of Service" updated="August 20, 2026">
      <section>
        <p>
          These terms govern your use of {APP_NAME}, the field-service platform for pet-care
          businesses available at app.houndstack.com. By creating an account or using the service
          you agree to them. If you are accepting on behalf of a business, you confirm you have
          authority to bind that business.
        </p>
        <p>
          <strong>These terms do not give consent to receive text messages.</strong> Consent to be
          texted by {APP_NAME} is separate and optional, is collected on its own by a box that
          starts unticked, and is never a condition of creating an account, buying a plan or using
          the service. Declining or withdrawing it changes nothing about your account. See the{" "}
          <a href="/legal/sms">SMS Consent &amp; Messaging Policy</a>.
        </p>
      </section>

      <section>
        <h2>Your account</h2>
        <ul>
          <li>You must provide accurate information and keep your credentials secure.</li>
          <li>
            You are responsible for activity under your account, including the actions of teammates
            you invite and the roles you assign them.
          </li>
          <li>You must be at least 18 years old to use the service.</li>
        </ul>
      </section>

      <section>
        <h2>Your data and your customers</h2>
        <ul>
          <li>
            You own the business data you store in {APP_NAME} (clients, schedules, invoices,
            photos, messages). You grant us the limited rights needed to host and process it to
            provide the service.
          </li>
          <li>
            You are responsible for having the right to store your customers' information, and for
            obtaining any consent required to contact them, including texting consent. {APP_NAME}
            enforces SMS opt-outs automatically, but the underlying consent is yours to collect.
          </li>
          <li>
            You will comply with applicable laws when using the service, including telemarketing
            and messaging laws (such as the TCPA), consumer-protection laws, and data-protection
            laws.
          </li>
        </ul>
      </section>

      <section>
        <h2>Payments and billing</h2>
        <ul>
          <li>
            Subscriptions are billed through Stripe on the plan you choose. Each plan is a flat
            monthly or yearly price that includes an allowance of active employees; each active
            employee beyond that allowance adjusts your bill at the published per-employee rate.
          </li>
          <li>
            Each plan also includes a monthly allowance of AI actions. Usage beyond that allowance
            is billed at the published per-action rate and appears as a single line on your next
            invoice. Your current allowance, usage and rate are shown in the app under Settings →
            AI usage, where you can also set a ceiling that stops AI rather than billing past it.
          </li>
          <li>
            You can cancel at any time; paid access continues to the end of the billing period.
            Fees already paid are non-refundable except where required by law.
          </li>
          <li>
            Payments you collect from your own customers run through your connected Stripe account
            and are subject to Stripe's terms. {APP_NAME} is not a party to the service
            relationship between you and your customers.
          </li>
        </ul>
      </section>

      <section>
        <h2>Acceptable use</h2>
        <p>You agree not to:</p>
        <ul>
          <li>use the service to send spam or messages without required consent;</li>
          <li>upload unlawful content or content that infringes others' rights;</li>
          <li>probe, disrupt, or overload the service or attempt to access others' data;</li>
          <li>resell or white-label the service without a written agreement with us.</li>
        </ul>
        <p>
          We may suspend accounts that violate these terms, put the platform at risk, or generate
          carrier complaints, after notice where practical.
        </p>
      </section>

      <section>
        <h2>Service and support</h2>
        <p>
          We work to keep the service available and fast, but it is provided "as is" without
          warranties of any kind. We may update features over time. Support is available at{" "}
          <a href="mailto:support@houndstack.com">support@houndstack.com</a>.
        </p>
      </section>

      <section>
        <h2>Limitation of liability</h2>
        <p>
          To the fullest extent permitted by law, {APP_NAME} will not be liable for indirect,
          incidental, special, consequential, or punitive damages, or lost profits or revenue. Our
          total liability for any claim is limited to the amounts you paid us in the twelve months
          before the claim arose.
        </p>
      </section>

      <section>
        <h2>Termination</h2>
        <p>
          You may stop using the service and cancel at any time. We may terminate or suspend
          accounts for material breach of these terms. After termination you may request an export
          of your data for a reasonable period before it is deleted.
        </p>
      </section>

      <section>
        <h2>Changes and contact</h2>
        <p>
          We may update these terms; material changes will be announced in the app or by email, and
          continued use after the effective date constitutes acceptance. Questions:{" "}
          <a href="mailto:support@houndstack.com">support@houndstack.com</a>.
        </p>
      </section>
    </LegalShell>
  );
}
