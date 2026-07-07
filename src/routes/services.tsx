import { createFileRoute, Link } from "@tanstack/react-router";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/services")({
  head: () => ({
    meta: [
      { title: `Services — ${APP_NAME}` },
      {
        name: "description",
        content:
          "Everything included with HoundStack: recurring visits, dispatch, billing, SMS, portal, weather rescheduling, and more.",
      },
      { property: "og:title", content: `Services — ${APP_NAME}` },
      {
        property: "og:description",
        content: "Every feature that ships with HoundStack for pet waste removal companies.",
      },
      { property: "og:url", content: "https://pal-primer.lovable.app/services" },
    ],
    links: [{ rel: "canonical", href: "https://pal-primer.lovable.app/services" }],
  }),
  component: ServicesPage,
});

const GROUPS = [
  {
    title: "Operations",
    items: [
      "Recurring visits with preferred weekdays",
      "Zone-based routing by postal prefix",
      "Multi-tech dispatch with drag-and-drop",
      "Blackout dates and auto bump-forward",
      "Weather-aware rescheduling",
    ],
  },
  {
    title: "Field crew",
    items: [
      "Mobile My Day view",
      "Offline visit completion with photo queue",
      "Safety hazard banners (bees, aggressive dogs)",
      "Tap-to-call and tap-to-navigate",
      "Photo capture with categories",
    ],
  },
  {
    title: "Billing",
    items: [
      "Prepaid credit ledgers or postpaid invoices",
      "Stripe checkout (BYO key)",
      "Automatic overdue reminders",
      "Skip-reason billing rules",
      "Client portal for payments",
    ],
  },
  {
    title: "Growth",
    items: [
      "Two-way SMS via Twilio",
      "Transactional email on your domain",
      "Google review prompts after visits",
      "Referral codes with dual-sided credit",
      "Client portal with a private token",
    ],
  },
];

function ServicesPage() {
  return (
    <MarketingLayout>
      <section className="mx-auto max-w-6xl px-6 pt-20 pb-8">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">
          Everything you need to run the route.
        </h1>
        <p className="mt-4 max-w-2xl text-muted-foreground">
          {APP_NAME} isn&rsquo;t a general CRM with pet-waste bolted on. Every screen was designed
          for scoop businesses first.
        </p>
      </section>
      <section className="mx-auto grid max-w-6xl gap-6 px-6 pb-20 sm:grid-cols-2">
        {GROUPS.map((g) => (
          <div key={g.title} className="rounded-lg border bg-card p-6">
            <h2 className="text-lg font-semibold">{g.title}</h2>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              {g.items.map((it) => (
                <li key={it} className="flex gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  <span>{it}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <div className="mx-auto max-w-6xl px-6 pb-24">
        <Link
          to="/contact"
          className="rounded-md bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Book a walkthrough
        </Link>
      </div>
    </MarketingLayout>
  );
}
