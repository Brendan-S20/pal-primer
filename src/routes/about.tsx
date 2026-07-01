import { createFileRoute } from "@tanstack/react-router";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: `About — ${APP_NAME}` },
      {
        name: "description",
        content:
          "Why we built Scoop CRM: field-service tools designed exclusively for the pet waste removal trade.",
      },
      { property: "og:title", content: `About — ${APP_NAME}` },
      {
        property: "og:description",
        content: "Field-service tools designed exclusively for scoop businesses.",
      },
      { property: "og:url", content: "https://pal-primer.lovable.app/about" },
    ],
    links: [{ rel: "canonical", href: "https://pal-primer.lovable.app/about" }],
  }),
  component: AboutPage,
});

function AboutPage() {
  return (
    <MarketingLayout>
      <section className="mx-auto max-w-3xl px-6 pt-20 pb-24">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">About {APP_NAME}</h1>
        <div className="mt-8 space-y-6 text-base text-muted-foreground">
          <p>
            Most field-service software was built for HVAC, landscaping, or plumbing — then
            marketed to scoop companies with the promise that it&rsquo;s &ldquo;flexible enough.&rdquo;
            We disagreed.
          </p>
          <p>
            Scoop businesses have their own rhythm: weekly frequencies, per-dog pricing, weather
            reschedules, gate codes and hazards to remember, and a route that lives or dies by
            windshield time. {APP_NAME} is built for exactly that.
          </p>
          <p>
            Every feature — from the offline-first tech app to the referral credit ledger — is
            here because a real operator asked for it. We ship weekly, we listen to our customers,
            and we don&rsquo;t nickel-and-dime on integrations. Bring your own Stripe, your own
            Twilio, your own domain. It&rsquo;s your business.
          </p>
        </div>
      </section>
    </MarketingLayout>
  );
}
