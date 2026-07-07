import { createFileRoute, Link } from "@tanstack/react-router";
import { MarketingLayout } from "@/components/marketing/MarketingLayout";
import { APP_NAME } from "@/lib/scoop";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: `About — ${APP_NAME}` },
      {
        name: "description",
        content:
          "Why we built HoundStack: field-service tools designed exclusively for the pet waste removal trade.",
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

const VALUES = [
  { t: "Built with operators", b: "Every feature ships after a real owner tells us it's broken. No mystery roadmap." },
  { t: "Own your stack", b: "Bring your own Stripe, Twilio, and domain. Zero markups, full portability." },
  { t: "Field-first, always", b: "If it slows down a tech on a driveway, it doesn't ship. Speed is a feature." },
];

function AboutPage() {
  return (
    <MarketingLayout>
      <section className="marketing-hero-gradient">
        <div className="mx-auto max-w-3xl px-6 pt-20 pb-16 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-xs font-medium text-brand-ink">
            About us
          </div>
          <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-5xl">
            We build the tool we wish we'd had.
          </h1>
          <p className="mt-4 text-muted-foreground">
            {APP_NAME} exists because pet waste removal deserves better than repurposed HVAC software.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-3xl px-6 py-16">
        <div className="prose prose-neutral dark:prose-invert max-w-none space-y-6 text-base leading-relaxed text-muted-foreground">
          <p>
            Most field-service software was built for HVAC, landscaping, or plumbing — then
            marketed to scoop companies with the promise that it's "flexible enough." We disagreed.
          </p>
          <p>
            Scoop businesses have their own rhythm: weekly frequencies, per-dog pricing, weather
            reschedules, gate codes and hazards to remember, and a route that lives or dies by
            windshield time. {APP_NAME} is built for exactly that.
          </p>
          <p>
            Every feature — from the offline-first tech app to the referral credit ledger — is
            here because a real operator asked for it. We ship weekly, we listen to our customers,
            and we don't nickel-and-dime on integrations.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-16">
        <div className="grid gap-6 sm:grid-cols-3">
          {VALUES.map((v, i) => (
            <div key={v.t} className="rounded-2xl border bg-card p-6">
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-brand-soft text-brand-ink font-semibold">
                0{i + 1}
              </div>
              <h3 className="mt-4 font-semibold">{v.t}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{v.b}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-6 pb-24">
        <div className="rounded-3xl border bg-card p-10 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">Come see for yourself.</h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-muted-foreground">
            15 minutes on a screen-share and you'll know if we're the right fit.
          </p>
          <Link
            to="/contact"
            className="mt-6 inline-flex rounded-full bg-brand px-5 py-3 text-sm font-medium text-brand-foreground hover:opacity-90 transition"
          >
            Book a demo →
          </Link>
        </div>
      </section>
    </MarketingLayout>
  );
}
