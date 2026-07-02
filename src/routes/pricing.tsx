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
    cta: { to: "/auth" as const, label: "Start free" },
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
    cta: { to: "/contact" as const, label: "Start Starter" },
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
    cta: { to: "/contact" as const, label: "Talk to us" },
  },
];

const FAQ = [
  {
    q: "What counts as an active client?",
    a: "Any client with at least one visit scheduled or completed in the last 30 days. Paused and archived clients don't count.",
  },
  {
    q: "Do you take a cut of my payments?",
    a: "No. Stripe and Twilio are bring-your-own-keys — you pay them directly and we never touch the money.",
  },
  {
    q: "Can I switch plans later?",
    a: "Any time. We prorate up or down automatically at the next billing cycle.",
  },
  {
    q: "Is my data locked in?",
    a: "Never. Full CSV export is one click away for clients, visits, invoices, and payments.",
  },
];

function PricingPage() {
  return (
    <MarketingLayout>
      <section className="marketing-hero-gradient">
        <div className="mx-auto max-w-3xl px-6 pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-xs font-medium text-brand-ink">
            Simple, transparent pricing
          </div>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
            Start free. Grow when you're ready.
          </h1>
          <p className="mx-auto mt-4 max-w-xl text-muted-foreground">
            Flat monthly tiers with no per-visit fees, no per-tech fees, and no surprise markups on Stripe or SMS.
          </p>
        </div>
      </section>

      <section className="mx-auto -mt-8 grid max-w-6xl gap-6 px-6 pb-16 sm:grid-cols-3">
        {TIERS.map((t) => (
          <div
            key={t.name}
            className={`relative rounded-2xl border bg-card p-7 transition ${
              t.highlight
                ? "border-brand shadow-xl ring-1 ring-brand/30 sm:-mt-4 sm:pb-10"
                : "hover:shadow-md"
            }`}
          >
            {t.highlight && (
              <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-brand-foreground shadow">
                Most popular
              </div>
            )}
            <div className="text-sm font-medium text-muted-foreground">{t.name}</div>
            <div className="mt-3 flex items-baseline gap-1">
              <div className="text-4xl font-semibold tracking-tight">{t.price}</div>
              <div className="text-sm text-muted-foreground">{t.per}</div>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">{t.tag}</div>
            <ul className="mt-6 space-y-3 text-sm">
              {t.features.map((f) => (
                <li key={f} className="flex items-start gap-2.5">
                  <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-soft text-brand-ink">
                    <svg viewBox="0 0 20 20" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="3">
                      <path d="M4 10l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
            <Link
              to={t.cta.to}
              className={`mt-8 inline-flex w-full items-center justify-center rounded-full px-4 py-2.5 text-sm font-medium transition ${
                t.highlight
                  ? "bg-brand text-brand-foreground hover:opacity-90"
                  : "border border-input hover:bg-accent"
              }`}
            >
              {t.cta.label}
            </Link>
          </div>
        ))}
      </section>

      <section className="mx-auto max-w-3xl px-6 pb-24">
        <h2 className="text-center text-2xl font-semibold tracking-tight">Common questions</h2>
        <dl className="mt-8 divide-y rounded-2xl border bg-card">
          {FAQ.map((item) => (
            <div key={item.q} className="p-6">
              <dt className="font-medium">{item.q}</dt>
              <dd className="mt-2 text-sm text-muted-foreground">{item.a}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-8 text-center text-xs text-muted-foreground">
          Prices in USD. Bring your own Stripe and Twilio keys — no markups from {APP_NAME}.
        </p>
      </section>
    </MarketingLayout>
  );
}
