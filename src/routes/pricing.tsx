import { createFileRoute, Link } from "@tanstack/react-router";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: `Pricing — ${APP_NAME}` },
      {
        name: "description",
        content:
          "Simple, per-active-client pricing. Free forever for the first 3 clients, then flat monthly tiers as you grow.",
      },
      { property: "og:title", content: `Pricing — ${APP_NAME}` },
      {
        property: "og:description",
        content: "Free up to 3 active clients. Flat monthly tiers after that.",
      },
      { property: "og:url", content: "https://pal-primer.lovable.app/pricing" },
    ],
    links: [{ rel: "canonical", href: "https://pal-primer.lovable.app/pricing" }],
  }),
  component: PricingPage,
});

const TIERS = [
  {
    name: "Free",
    price: "$0",
    per: "/ month",
    tag: "Up to 3 active clients",
    features: ["All operational features", "1 technician", "Community support"],
    cta: { to: "/auth", label: "Start free" as const },
  },
  {
    name: "Starter",
    price: "$49",
    per: "/ month",
    tag: "Up to 25 active clients",
    features: [
      "Everything in Free",
      "Unlimited technicians",
      "Two-way SMS (Twilio BYOK)",
      "Stripe invoicing (BYOK)",
    ],
    cta: { to: "/contact", label: "Talk to us" as const },
    highlight: true,
  },
  {
    name: "Growth",
    price: "$129",
    per: "/ month",
    tag: "Up to 150 active clients",
    features: [
      "Everything in Starter",
      "Reviews + referrals",
      "Weather rescheduling",
      "Priority support",
    ],
    cta: { to: "/contact", label: "Talk to us" as const },
  },
];

function PricingPage() {
  return (
    <MarketingLayout>
      <section className="mx-auto max-w-6xl px-6 pt-20 pb-12 text-center">
        <h1 className="text-4xl font-semibold tracking-tight sm:text-5xl">Simple pricing.</h1>
        <p className="mx-auto mt-4 max-w-2xl text-muted-foreground">
          Start free. Pay only when the tool is already paying for itself.
        </p>
      </section>
      <section className="mx-auto grid max-w-6xl gap-6 px-6 pb-20 sm:grid-cols-3">
        {TIERS.map((t) => (
          <div
            key={t.name}
            className={`rounded-2xl border bg-card p-6 ${
              t.highlight ? "border-primary shadow-lg ring-1 ring-primary/20" : ""
            }`}
          >
            <div className="text-sm font-medium text-muted-foreground">{t.name}</div>
            <div className="mt-3 flex items-baseline gap-1">
              <div className="text-4xl font-semibold">{t.price}</div>
              <div className="text-sm text-muted-foreground">{t.per}</div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{t.tag}</div>
            <ul className="mt-6 space-y-2 text-sm text-muted-foreground">
              {t.features.map((f) => (
                <li key={f} className="flex gap-2">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                  {f}
                </li>
              ))}
            </ul>
            <Link
              to={t.cta.to}
              className={`mt-6 inline-flex w-full items-center justify-center rounded-md px-4 py-2 text-sm font-medium ${
                t.highlight
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "border border-input hover:bg-accent"
              }`}
            >
              {t.cta.label}
            </Link>
          </div>
        ))}
      </section>
      <p className="mx-auto max-w-2xl px-6 pb-20 text-center text-xs text-muted-foreground">
        Prices in USD. Bring your own Stripe and Twilio keys — no markups from {APP_NAME}.
      </p>
    </MarketingLayout>
  );
}
