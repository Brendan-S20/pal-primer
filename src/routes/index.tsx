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

const FEATURES = [
  {
    icon: "🗓",
    title: "Smart recurring visits",
    body: "Weekly cadences, blackout dates, and preferred weekdays. Visits auto-generate and re-flow around weather.",
  },
  {
    icon: "🗺",
    title: "Route optimization",
    body: "Zone-based dispatch and one-click optimize keeps windshield time down and revenue per hour up.",
  },
  {
    icon: "📱",
    title: "Field-first mobile app",
    body: "Techs work offline, capture photos, and finish visits in one tap. Works on any phone browser.",
  },
  {
    icon: "💳",
    title: "Prepaid or postpaid billing",
    body: "Stripe-powered invoices, credit ledgers, saved cards, and automatic overdue reminders. BYOK.",
  },
  {
    icon: "💬",
    title: "SMS + email built in",
    body: "Two-way texting, on-my-way pings, weather reschedules, and review requests — all handled.",
  },
  {
    icon: "🌱",
    title: "Growth on autopilot",
    body: "Referral codes, account credit for both sides, and Google review prompts after every visit.",
  },
];

const STATS = [
  { k: "10k+", v: "visits routed weekly" },
  { k: "38%", v: "less windshield time" },
  { k: "< 60s", v: "to complete a stop" },
];

function HomePage() {
  return (
    <MarketingLayout>
      <section className="marketing-hero-gradient">
        <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 pt-20 pb-24 sm:pt-28 lg:grid-cols-[1.15fr_1fr]">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand-soft px-3 py-1 text-xs font-medium text-brand-ink">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-brand" />
              Built for pet waste removal companies
            </div>
            <h1 className="mt-6 text-4xl font-semibold tracking-tight sm:text-6xl">
              Run every visit, route, and invoice{" "}
              <span className="text-brand">from one clean app.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted-foreground">
              {APP_NAME} handles recurring visits, per-dog pricing, weather rescheduling, technician
              routes, client billing, and reviews — so you spend your day scooping, not
              spreadsheeting.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link
                to="/contact"
                className="rounded-full bg-brand px-5 py-3 text-sm font-medium text-brand-foreground shadow-sm hover:opacity-90 transition"
              >
                Book a demo →
              </Link>
              <Link
                to="/pricing"
                className="rounded-full border border-input bg-background px-5 py-3 text-sm font-medium hover:bg-accent transition"
              >
                See pricing
              </Link>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Free while you have 3 or fewer active clients. No credit card.
            </p>
          </div>

          <div className="relative">
            <div className="absolute -inset-6 rounded-3xl bg-brand/10 blur-2xl" aria-hidden />
            <div className="relative rounded-2xl border bg-card p-4 shadow-xl">
              <div className="flex items-center gap-1.5 border-b pb-3">
                <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-yellow-400" />
                <span className="h-2.5 w-2.5 rounded-full bg-green-400" />
                <span className="ml-3 text-xs text-muted-foreground">Today · 12 stops · Owen</span>
              </div>
              <ul className="mt-3 space-y-2">
                {[
                  { addr: "142 Maple Ave", tag: "2 dogs", done: true },
                  { addr: "88 Cedar Ln", tag: "1 dog", done: true },
                  { addr: "310 Oak Ridge Rd", tag: "3 dogs · gate 4421", done: false, now: true },
                  { addr: "27 Birchwood Ct", tag: "1 dog", done: false },
                  { addr: "555 Poplar Hills", tag: "2 dogs · leash", done: false },
                ].map((s) => (
                  <li
                    key={s.addr}
                    className={`flex items-center justify-between rounded-lg border p-3 text-sm ${
                      s.now ? "border-brand bg-brand-soft/50" : ""
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-medium ${
                          s.done
                            ? "bg-brand text-brand-foreground"
                            : s.now
                              ? "bg-brand/20 text-brand-ink ring-2 ring-brand"
                              : "bg-muted text-muted-foreground"
                        }`}
                      >
                        {s.done ? "✓" : ""}
                      </span>
                      <div>
                        <div className={`font-medium ${s.done ? "line-through text-muted-foreground" : ""}`}>
                          {s.addr}
                        </div>
                        <div className="text-xs text-muted-foreground">{s.tag}</div>
                      </div>
                    </div>
                    {s.now && (
                      <span className="rounded-full bg-brand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-foreground">
                        Now
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y bg-muted/40">
        <div className="mx-auto grid max-w-6xl grid-cols-3 gap-6 px-6 py-10 text-center">
          {STATS.map((s) => (
            <div key={s.v}>
              <div className="text-3xl font-semibold tracking-tight text-brand sm:text-4xl">{s.k}</div>
              <div className="mt-1 text-xs text-muted-foreground sm:text-sm">{s.v}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 py-24">
        <div className="mx-auto max-w-2xl text-center">
          <div className="text-xs font-semibold uppercase tracking-wider text-brand">Everything you need</div>
          <h2 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
            One system, tail to trowel.
          </h2>
          <p className="mt-3 text-muted-foreground">
            Ops, billing, dispatch, and the tech app — designed together so nothing falls through the cracks.
          </p>
        </div>
        <div className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((f) => (
            <div
              key={f.title}
              className="group rounded-2xl border bg-card p-6 transition hover:border-brand/40 hover:shadow-md"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-soft text-2xl text-brand-ink transition group-hover:scale-105">
                <span aria-hidden>{f.icon}</span>
              </div>
              <h3 className="mt-4 text-base font-semibold">{f.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-5xl px-6 pb-24">
        <figure className="rounded-3xl border bg-card p-8 shadow-sm sm:p-12">
          <div className="text-4xl leading-none text-brand">“</div>
          <blockquote className="mt-2 text-xl font-medium leading-relaxed tracking-tight sm:text-2xl">
            We cut our office time in half and doubled our route density in the first month.
            The tech app is what sold my crew — they haven't asked for paper since.
          </blockquote>
          <figcaption className="mt-6 flex items-center gap-3 text-sm">
            <div className="h-10 w-10 rounded-full bg-brand-soft" />
            <div>
              <div className="font-medium">Jamie R.</div>
              <div className="text-muted-foreground">Owner, Poop Patrol Co.</div>
            </div>
          </figcaption>
        </figure>
      </section>

      <section className="mx-auto max-w-4xl px-6 pb-24">
        <div className="overflow-hidden rounded-3xl bg-brand p-10 text-center text-brand-foreground shadow-lg sm:p-14">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">Ready to see it live?</h2>
          <p className="mx-auto mt-3 max-w-xl opacity-90">
            Tell us a bit about your route and we'll show you a 15-minute walkthrough on your data.
          </p>
          <div className="mt-8 flex flex-wrap justify-center gap-3">
            <Link
              to="/contact"
              className="rounded-full bg-background px-5 py-3 text-sm font-medium text-foreground hover:opacity-90 transition"
            >
              Request a demo
            </Link>
            <Link
              to="/pricing"
              className="rounded-full border border-white/25 px-5 py-3 text-sm font-medium hover:bg-white/10 transition"
            >
              See pricing
            </Link>
          </div>
        </div>
      </section>
    </MarketingLayout>
  );
}
