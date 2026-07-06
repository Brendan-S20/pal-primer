import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { APP_NAME } from "@/lib/scoop";
import { listPublicPlans, type PublicPlan } from "@/lib/plans.functions";

export const Route = createFileRoute("/pricing")({
  head: () => ({
    meta: [
      { title: `Pricing — ${APP_NAME}` },
      {
        name: "description",
        content:
          "Simple, per-active-client pricing. Free forever for the first 3 clients, then flat monthly tiers as you grow. Unlimited staff on every plan.",
      },
      { property: "og:title", content: `Pricing — ${APP_NAME}` },
      {
        property: "og:description",
        content: "Free up to 3 active clients. Flat monthly tiers after that. Unlimited staff on every plan.",
      },
      { property: "og:url", content: "https://pal-primer.lovable.app/pricing" },
    ],
    links: [{ rel: "canonical", href: "https://pal-primer.lovable.app/pricing" }],
  }),
  component: PricingPage,
});

const FAQ = [
  {
    q: "What counts as an active client?",
    a: "Any client with at least one visit scheduled or completed in the last 30 days. Paused and archived clients don't count.",
  },
  {
    q: "Do you charge per technician?",
    a: "No — every plan, including Free, includes unlimited staff seats. You only pay based on how many active clients you serve.",
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

function formatBand(p: PublicPlan): string {
  const min = p.client_limit_min ?? 0;
  const max = p.client_limit_max;
  if (max == null) return `${min}+ active clients`;
  if (min === 0) return `Up to ${max} active clients`;
  return `${min}–${max} active clients`;
}

function formatPrice(p: PublicPlan): { price: string; per: string } {
  if (p.price_cents != null && p.price_cents === 0) return { price: "$0", per: "/ month" };
  if (p.price_cents != null) {
    return {
      price: `$${(p.price_cents / 100).toLocaleString()}`,
      per: "/ month",
    };
  }
  if (p.price_per_client_cents != null) {
    return {
      price: `$${(p.price_per_client_cents / 100).toFixed(2)}`,
      per: "/ client / mo",
    };
  }
  return { price: "—", per: "" };
}

function planFeatures(p: PublicPlan, idx: number): string[] {
  const base = [
    "Unlimited staff seats",
    "Routes, invoicing, messaging",
    "Client & neighbor management",
  ];
  if (p.is_free) return ["All core features", ...base.slice(0, 1), "Community support"];
  if (idx === 1) return [...base, "Two-way SMS (BYOK)", "Stripe invoicing (BYOK)"];
  if (idx === 2) return [...base, "Weather rescheduling", "Reviews + referrals", "Priority email support"];
  return [...base, "Volume-friendly pricing", "Dedicated onboarding help"];
}

function PricingPage() {
  const listFn = useServerFn(listPublicPlans);
  const { data, isLoading, isError } = useQuery({
    queryKey: ["public-plans"],
    queryFn: () => listFn(),
    staleTime: 5 * 60_000,
  });

  const plans = data?.plans ?? [];

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
            Pay by how many active clients you have — never by seat, never per visit. Unlimited staff on every plan.
          </p>
        </div>
      </section>

      <section className="mx-auto -mt-8 max-w-6xl px-6 pb-16">
        {isLoading && (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-64 animate-pulse rounded-2xl border bg-card" />
            ))}
          </div>
        )}
        {isError && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm text-destructive">
            Couldn't load plans right now. Please refresh.
          </p>
        )}
        {!isLoading && !isError && (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
            {plans.map((p, idx) => {
              const { price, per } = formatPrice(p);
              const highlight = idx === 1; // second card visually featured
              return (
                <div
                  key={p.id}
                  className={`relative rounded-2xl border bg-card p-7 transition ${
                    highlight
                      ? "border-brand shadow-xl ring-1 ring-brand/30 lg:-mt-4 lg:pb-10"
                      : "hover:shadow-md"
                  }`}
                >
                  {highlight && (
                    <div className="absolute -top-3 left-1/2 -translate-x-1/2 rounded-full bg-brand px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-brand-foreground shadow">
                      Most popular
                    </div>
                  )}
                  <div className="text-sm font-medium text-muted-foreground">{p.name}</div>
                  <div className="mt-3 flex items-baseline gap-1">
                    <div className="text-4xl font-semibold tracking-tight">{price}</div>
                    <div className="text-sm text-muted-foreground">{per}</div>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{formatBand(p)}</div>
                  <ul className="mt-6 space-y-3 text-sm">
                    {planFeatures(p, idx).map((f) => (
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
                    to={p.is_free ? "/auth" : "/contact"}
                    className={`mt-8 inline-flex w-full items-center justify-center rounded-full px-4 py-2.5 text-sm font-medium transition ${
                      highlight
                        ? "bg-brand text-brand-foreground hover:opacity-90"
                        : "border border-input hover:bg-accent"
                    }`}
                  >
                    {p.is_free ? "Start free" : `Talk to us`}
                  </Link>
                </div>
              );
            })}
          </div>
        )}
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
