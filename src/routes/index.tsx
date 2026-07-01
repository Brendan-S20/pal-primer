import { createFileRoute, Link } from "@tanstack/react-router";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: `${APP_NAME} — Field service software for pet waste removal` },
      {
        name: "description",
        content:
          "Route optimization, recurring visits, per-dog pricing, client billing, and a mobile field app — purpose-built for scoop businesses.",
      },
      { property: "og:title", content: `${APP_NAME} — Software for scoop businesses` },
      {
        property: "og:description",
        content: "Everything you need to run and grow a pet waste removal company.",
      },
      { property: "og:url", content: "https://pal-primer.lovable.app/" },
    ],
    links: [{ rel: "canonical", href: "https://pal-primer.lovable.app/" }],
  }),
  component: HomePage,
});

function HomePage() {
  return (
    <MarketingLayout>
      <section className="mx-auto max-w-6xl px-6 pt-20 pb-24 sm:pt-28">
        <div className="max-w-3xl">
          <div className="inline-flex items-center rounded-full border border-border bg-muted px-3 py-1 text-xs font-medium text-muted-foreground">
            Built for pet waste removal companies
          </div>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-6xl">
            Run every visit, route, and invoice from one clean app.
          </h1>
          <p className="mt-6 text-lg text-muted-foreground">
            {APP_NAME} handles recurring visits, per-dog pricing, weather rescheduling, technician
            routes, client billing, and reviews — so you can spend your day scooping, not
            spreadsheeting.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/contact"
              className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Book a demo
            </Link>
            <Link
              to="/pricing"
              className="rounded-md border border-input px-5 py-2.5 text-sm font-medium hover:bg-accent"
            >
              See pricing
            </Link>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Free while you have 3 or fewer active clients. No credit card.
          </p>
        </div>
      </section>

      <section className="border-t bg-muted/30">
        <div className="mx-auto grid max-w-6xl gap-8 px-6 py-20 sm:grid-cols-2 lg:grid-cols-3">
          {[
            {
              title: "Smart recurring visits",
              body:
                "Set weekly cadences, blackout dates, and preferred weekdays. Visits auto-generate and re-flow around weather.",
            },
            {
              title: "Route optimization by zone",
              body:
                "Postal-prefix zoning and drag-and-drop dispatch keep windshield time down and revenue per hour up.",
            },
            {
              title: "Field-first mobile app",
              body:
                "Techs work offline, capture photos, and finish visits in one tap. Works on any phone with a browser.",
            },
            {
              title: "Prepaid or postpaid billing",
              body:
                "Stripe-powered invoices, credit ledgers, and automatic overdue reminders. Bring your own Stripe key.",
            },
            {
              title: "SMS + email that just works",
              body:
                "Two-way texting, on-my-way pings, weather reschedules, and review requests — all built in.",
            },
            {
              title: "Growth on autopilot",
              body:
                "Referral codes, account credit for both sides, and Google review prompts after every completed visit.",
            },
          ].map((f) => (
            <div key={f.title} className="rounded-lg border bg-card p-6">
              <h3 className="text-base font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-24 text-center">
        <h2 className="text-3xl font-semibold tracking-tight">Ready to see it live?</h2>
        <p className="mt-3 text-muted-foreground">
          Tell us a bit about your route and we&rsquo;ll show you a 15-minute walkthrough.
        </p>
        <div className="mt-6">
          <Link
            to="/contact"
            className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Request a demo
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
