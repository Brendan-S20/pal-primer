import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  CalendarDays,
  Home,
  Receipt,
  MapPin as MapPinIcon,
  MessageCircleWarning,
  User,
  Mail,
  Phone,
} from "lucide-react";
import { PushToggle } from "@/components/PushToggle";
import {
  PortalProvider,
  usePortalCtx,
  PortalVerifyGate,
  PortalDeadEnd,
  money,
  isHex,
} from "@/lib/portal-ui";
import { cadenceLabel } from "@/lib/frequency-request";
import { visitServiceLabel } from "@/lib/visit-service";
import { customerTitle, useDocumentTitle } from "@/lib/page-title";

export const Route = createFileRoute("/portal/$slug/$token")({
  head: () => ({
    meta: [
      { title: customerTitle("Your service portal") },
      { name: "description", content: "View upcoming visits, invoices, and account details." },
    ],
  }),
  component: PortalLayout,
  // These two run OUTSIDE the provider, so there is no branding to hand them
  // — but a plain card with real sentences still beats a bare div with a
  // database error in it.
  errorComponent: ({ error }) => (
    <PortalDeadEnd
      title="We can't load your account right now"
      body={
        <>
          <p>This is on our side, not yours. Nothing about your service has changed.</p>
          <p className="mt-2">
            Try again in a minute, or reply to any of our texts or emails and we'll help.
          </p>
        </>
      }
      detail={error.message}
    />
  ),
  notFoundComponent: () => (
    <PortalDeadEnd
      title="That link doesn't go anywhere"
      body={
        <>
          <p>The address may have been copied incompletely, or the page has moved.</p>
          <p className="mt-2">
            The link in your most recent text or email is always the current one.
          </p>
        </>
      }
    />
  ),
});

function PortalLayout() {
  const { slug, token } = Route.useParams();
  return (
    <PortalProvider token={token} slug={slug}>
      <PortalShell />
    </PortalProvider>
  );
}

function PortalShell() {
  const { token, slug, clientQ, contextQ, verified } = usePortalCtx();
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  // Which of the six tabs is open, by the same matching the tab bar uses.
  const base = `/portal/${slug}/${token}`;
  const section = TABS.find((t) => {
    const target = t.to.replace("$slug", slug).replace("$token", token);
    return t.end ? pathname === target : pathname === target || pathname.startsWith(target + "/");
  });
  const onHome = pathname === base || pathname === base + "/";
  // The tab names the BUSINESS, never HoundStack: "Visits · Whitfield & Ramirez
  // Yard and Waste Services". The client signed up with them, and a tab with a
  // vendor's name on it is one they cannot place among their others.
  const orgName = (clientQ.data as { org_name?: string } | undefined)?.org_name;
  // A page under a tab that is not itself a tab (paying one invoice) keeps its
  // own name: without this the tab read only the business name, because this
  // effect replaced the pay page's "Pay invoice" with no label at all.
  const pageLabel = pathname.startsWith(`${base}/training`)
    ? "Training"
    : (section?.label ?? (pathname.startsWith(`${base}/pay/`) ? "Pay invoice" : null));
  useDocumentTitle(orgName ? customerTitle(pageLabel, orgName) : null);

  // Auth gate (finding #4): resolve the session before anything else.
  if (contextQ.isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-center text-sm text-muted-foreground">
        Loading your portal…
      </div>
    );
  }
  const ctx = contextQ.data as any;
  // "Invalid or expired portal link." was the whole page. It does not say
  // which of the two it is, that links expire on purpose, or how to get a
  // working one — and portal links DO expire, so this is a screen real
  // customers reach on the ordinary path, not an error state.
  if (!ctx || ctx.valid === false) {
    return (
      <PortalDeadEnd
        branding={ctx?.branding ?? null}
        title="This link has expired"
        body={
          <>
            <p>Portal links expire after a while to keep your account private.</p>
            <p className="mt-2">
              Open the link in your most recent text or email. That one still works.
            </p>
          </>
        }
      />
    );
  }
  if (!verified) {
    return <PortalVerifyGate />;
  }
  if (clientQ.isLoading) {
    return (
      <div className="mx-auto max-w-3xl p-8 text-center text-sm text-muted-foreground">
        Loading your portal…
      </div>
    );
  }
  if (clientQ.error || !clientQ.data) {
    return (
      <PortalDeadEnd
        branding={ctx?.branding ?? null}
        title="We can't load your account right now"
        body={
          <>
            <p>This is on our side. Nothing about your service has changed.</p>
            <p className="mt-2">Try again in a minute, or reply to any of our texts or emails.</p>
          </>
        }
        detail={(clientQ.error as Error | null)?.message ?? null}
      />
    );
  }
  const c = clientQ.data as any;
  const isCommercial = c.account_type === "commercial";
  const brand = isHex(c.brand_color) ? c.brand_color : "#16a34a";
  const headerStyle: React.CSSProperties = {
    background: `linear-gradient(135deg, ${brand} 0%, color-mix(in oklab, ${brand} 65%, black) 100%)`,
    color: "white",
  };

  // primary_unit_count is the subscription's billable UNITS, not waste
  // stations (G4 mislabel: "24 stations" for a 24-unit service).
  // The plan's days when it runs on a weekday set ("Mon–Fri"), else its
  // frequency; and, first, the business's own name for the service when it
  // is not the seeded pet waste removal ("30-minute walk · Mon–Fri · ...").
  // A pet-waste client's chip reads exactly as it did.
  const cadence = cadenceLabel(c.primary_frequency, c.primary_weekdays);
  const ownService = visitServiceLabel(
    c.primary_service_name
      ? { name: c.primary_service_name, service_line: c.primary_service_line }
      : null,
  )?.ownName;
  const planLead = ownService ? `${ownService} · ${cadence}` : cadence;
  const planChip = isCommercial
    ? `${planLead} · ${c.primary_unit_count ?? 0} unit${c.primary_unit_count === 1 ? "" : "s"} · ${money(c.primary_price_cents)}/visit`
    : `${planLead} · ${c.primary_dog_count ?? 0} dog${c.primary_dog_count === 1 ? "" : "s"} · ${money(c.primary_price_cents)}/visit`;

  return (
    <div className="min-h-screen bg-muted/20 pb-28">
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
        {ctx.preview && (
          // A staff preview (clients.functions previewClientPortal). The
          // server refuses every action on it; this says so before anybody
          // taps one and wonders why it failed.
          <div
            role="status"
            className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
          >
            <strong>Preview.</strong> This is what {c.display_name} sees. Nothing here can be
            changed from a preview, and it ends after an hour.
          </div>
        )}
        {/* ── WHO THIS IS FROM, AND WHAT YOU CAN DO HERE ───────────────────
            The header was a 280px green hero on all six tabs: the business's
            name in 12px uppercase above "Hello, {name}", then chips for the
            next visit, the plan and the balance. On a phone that was a third
            of the screen before any tab's own content, on every tab, and Home
            then repeated "Next visit" in a card right under it (launch pass,
            2026-10, recommendation 7).

            So, on every tab: the business's logo and NAME, large, because it
            is the one thing a client opening a link from a text needs to
            recognise; and who is signed in, small. On Home only: the greeting,
            one sentence of what this portal is for, and the plan and balance
            chips. The next-visit chip is gone because Home's first card is the
            next visit, with more in it. */}
        <header
          className="overflow-hidden rounded-2xl p-4 shadow-lg sm:p-5"
          style={headerStyle}
          data-testid="portal-header"
        >
          {/* Put notifications below the name when the row is too narrow. */}
          <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
            <div className="flex min-w-0 flex-[1_1_16rem] items-center gap-3">
              {c.logo_url ? (
                <img
                  src={c.logo_url}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-lg bg-white/90 object-contain p-1"
                />
              ) : (
                // No logo: the initial, so the name never sits beside an
                // empty square.
                <span
                  aria-hidden="true"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg bg-white/20 text-lg font-semibold"
                >
                  {String(c.org_name ?? "?")
                    .trim()
                    .charAt(0)
                    .toUpperCase()}
                </span>
              )}
              <div className="min-w-0">
                <h1 className="break-words text-lg font-semibold leading-tight sm:text-xl">
                  {c.org_name}
                </h1>
                <p className="truncate text-sm opacity-90">
                  {onHome ? `Hello, ${c.display_name}` : c.display_name}
                </p>
              </div>
            </div>

            <PushToggle
              portalToken={token}
              className="bg-white/15 text-white border-white/30 hover:bg-white/25 hover:text-white"
            />
          </div>

          {onHome && (
            <>
              <p className="mt-3 text-sm opacity-95">
                Your account with us: check your next visit, pay invoices, update your property and
                pets, or send us a request.
              </p>
              {(c.primary_frequency || c.credit_balance_cents !== 0) && (
                <div className="mt-3 flex flex-wrap gap-2 text-sm">
                  {c.primary_frequency && (
                    <Link
                      to="/portal/$slug/$token/visits"
                      params={{ slug, token }}
                      className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-full bg-white/15 px-3 py-1 backdrop-blur hover:bg-white/25 touch:min-h-11"
                    >
                      <span className="truncate">{planChip}</span>
                    </Link>
                  )}
                  {/* Only when there is something to show: a zero "Balance"
                      beside an "Open invoice" reads as a contradiction. The
                      positive side says "Account credit" so it cannot be
                      misread as "you owe $0". */}
                  {c.credit_balance_cents !== 0 && (
                    <Link
                      to="/portal/$slug/$token/billing"
                      params={{ slug, token }}
                      className="inline-flex min-h-9 items-center gap-2 rounded-full bg-white/15 px-3 py-1 backdrop-blur hover:bg-white/25 touch:min-h-11"
                    >
                      <span className="opacity-80">
                        {c.credit_balance_cents > 0 ? "Account credit" : "Amount due"}
                      </span>
                      <span className="font-semibold">
                        {money(Math.abs(c.credit_balance_cents))}
                      </span>
                    </Link>
                  )}
                </div>
              )}
            </>
          )}
        </header>

        {/* Section content */}
        <Outlet />

        {/* Contact footer */}
        <footer className="rounded-lg border bg-card p-4 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Questions? We're here.</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            {c.contact_phone && (
              <a
                href={`tel:${c.contact_phone}`}
                className="inline-flex items-center gap-1.5 hover:text-foreground"
              >
                <Phone className="h-4 w-4 shrink-0" /> {c.contact_phone}
              </a>
            )}
            {ctx.textsLive === true && c.contact_phone && (
              <a
                href={`sms:${c.contact_phone}`}
                className="inline-flex items-center gap-1.5 hover:text-foreground"
              >
                Text us
              </a>
            )}
            {c.contact_email && (
              <a
                href={`mailto:${c.contact_email}`}
                className="inline-flex items-center gap-1.5 hover:text-foreground"
              >
                <Mail className="h-4 w-4 shrink-0" /> {c.contact_email}
              </a>
            )}
          </div>
        </footer>
      </div>

      {/* Sticky bottom tab bar */}
      <BottomTabs token={token} slug={slug} isCommercial={isCommercial} />
    </div>
  );
}

const TABS = [
  { to: "/portal/$slug/$token", label: "Home", icon: Home, end: true },
  { to: "/portal/$slug/$token/visits", label: "Visits", icon: CalendarDays, end: false },
  { to: "/portal/$slug/$token/billing", label: "Billing", icon: Receipt, end: false },
  { to: "/portal/$slug/$token/property", label: "Property", icon: MapPinIcon, end: false },
  {
    to: "/portal/$slug/$token/requests",
    label: "Requests",
    icon: MessageCircleWarning,
    end: false,
  },
  { to: "/portal/$slug/$token/account", label: "Account", icon: User, end: false },
] as const;

function BottomTabs({
  token,
  slug,
  isCommercial,
}: {
  token: string;
  slug: string;
  isCommercial: boolean;
}) {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  return (
    <nav
      aria-label="Portal sections"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80"
    >
      <div className="mx-auto max-w-3xl">
        <ul className="grid grid-cols-6">
          {TABS.map((t) => {
            const target = t.to.replace("$slug", slug).replace("$token", token);
            // Training is reached from Visits (lessons are visits), so Visits
            // stays lit there: there is no room for a seventh tab at 320px.
            const base = `/portal/${slug}/${token}`;
            const active = t.end
              ? pathname === target
              : pathname === target ||
                pathname.startsWith(target + "/") ||
                (t.label === "Visits" && pathname.startsWith(`${base}/training`));
            const Icon = t.icon;
            const label = t.label === "Property" && isCommercial ? "Property" : t.label;
            return (
              <li key={t.to}>
                {/* G3: preload="render" fetches every tab's code-split chunk as
                    soon as the tab bar mounts, so the first tap swaps content
                    immediately instead of waiting on a chunk download (the
                    "highlighted but didn't navigate" dead click). */}
                <Link
                  to={t.to}
                  params={{ slug, token }}
                  preload="render"
                  className={`flex flex-col items-center gap-0.5 px-1 py-2 text-3xs font-medium transition-colors ${
                    active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  <Icon className="h-5 w-5" />
                  <span>{label}</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
