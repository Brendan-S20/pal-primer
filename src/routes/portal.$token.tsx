import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  CalendarDays, Home, Receipt, MapPin as MapPinIcon, MessageCircleWarning, User,
  Mail, Phone,
} from "lucide-react";
import { PushToggle } from "@/components/PushToggle";
import {
  PortalProvider, usePortalCtx, money, fmtDayShort, fmtTime, friendlyFrequency,
  isHex, relativeFromToday,
} from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$token")({
  head: () => ({
    meta: [
      { title: "Your service portal" },
      { name: "description", content: "View upcoming visits, invoices, and account details." },
    ],
  }),
  component: PortalLayout,
  errorComponent: ({ error }) => (
    <div className="mx-auto max-w-md p-8 text-center">
      <h1 className="text-xl font-semibold">Portal unavailable</h1>
      <p className="mt-2 text-sm text-muted-foreground">{error.message}</p>
    </div>
  ),
  notFoundComponent: () => (
    <div className="mx-auto max-w-md p-8 text-center">Portal not found.</div>
  ),
});

function PortalLayout() {
  const { token } = Route.useParams();
  return (
    <PortalProvider token={token}>
      <PortalShell />
    </PortalProvider>
  );
}

function PortalShell() {
  const { token, clientQ } = usePortalCtx();

  if (clientQ.isLoading) {
    return <div className="mx-auto max-w-3xl p-8 text-center text-sm text-muted-foreground">Loading your portal…</div>;
  }
  if (clientQ.error || !clientQ.data) {
    return <div className="mx-auto max-w-md p-8 text-center">Invalid or expired portal link.</div>;
  }
  const c = clientQ.data as any;
  const isCommercial = c.account_type === "commercial";
  const brand = isHex(c.brand_color) ? c.brand_color : "#16a34a";
  const headerStyle: React.CSSProperties = {
    background: `linear-gradient(135deg, ${brand} 0%, color-mix(in oklab, ${brand} 65%, black) 100%)`,
    color: "white",
  };

  const nextVisitDate = c.next_visit_on as string | null;
  const nextVisitEtaStart = c.next_visit_eta_start as string | null;
  const nextVisitEtaEnd = c.next_visit_eta_end as string | null;

  const planChip = isCommercial
    ? `${friendlyFrequency(c.primary_frequency)} · ${c.primary_unit_count ?? 0} station${c.primary_unit_count === 1 ? "" : "s"} · ${money(c.primary_price_cents)}/visit`
    : `${friendlyFrequency(c.primary_frequency)} · ${c.primary_dog_count ?? 0} dog${c.primary_dog_count === 1 ? "" : "s"} · ${money(c.primary_price_cents)}/visit`;

  return (
    <div className="min-h-screen bg-muted/20 pb-28">
      <div className="mx-auto max-w-3xl space-y-6 p-4 md:p-8">
        {/* Header — always visible across tabs */}
        <header className="overflow-hidden rounded-2xl p-6 shadow-lg" style={headerStyle}>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                {c.logo_url ? (
                  <img src={c.logo_url} alt={c.org_name} className="h-8 w-8 rounded bg-white/20 object-contain p-0.5" />
                ) : null}
                <div className="text-xs uppercase tracking-wider opacity-80">{c.org_name}</div>
              </div>
              <h1 className="mt-1 truncate text-2xl font-semibold sm:text-3xl">Hello, {c.display_name} 👋</h1>

              <div className="mt-3 flex flex-wrap gap-2 text-sm">
                {nextVisitDate ? (
                  <Link to="/portal/$token/visits" params={{ token }}
                    className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 backdrop-blur hover:bg-white/25">
                    <CalendarDays className="h-3.5 w-3.5" />
                    <span>
                      Next: <strong>{fmtDayShort(nextVisitDate)}</strong>
                      {nextVisitEtaStart && <> · {fmtTime(nextVisitEtaStart)}–{fmtTime(nextVisitEtaEnd)}</>}
                      {relativeFromToday(nextVisitDate) && <span className="opacity-80"> · {relativeFromToday(nextVisitDate)}</span>}
                    </span>
                  </Link>
                ) : (
                  <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1">
                    <CalendarDays className="h-3.5 w-3.5" /> No visit scheduled
                  </div>
                )}
                {c.primary_frequency && (
                  <Link to="/portal/$token/visits" params={{ token }}
                    className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 backdrop-blur hover:bg-white/25">
                    {planChip}
                  </Link>
                )}
                <Link to="/portal/$token/billing" params={{ token }}
                  className="inline-flex items-center gap-2 rounded-full bg-white/15 px-3 py-1 backdrop-blur hover:bg-white/25">
                  <span className="opacity-80">{c.credit_balance_cents >= 0 ? "Balance" : "Amount due"}</span>
                  <span className="font-semibold">{money(Math.abs(c.credit_balance_cents))}</span>
                </Link>
              </div>
            </div>

            <PushToggle portalToken={token}
              className="bg-white/15 text-white border-white/30 hover:bg-white/25 hover:text-white" />
          </div>
        </header>

        {/* Section content */}
        <Outlet />

        {/* Contact footer */}
        <footer className="rounded-lg border bg-card p-4 text-center text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Questions? We're here.</p>
          <div className="mt-2 flex flex-wrap items-center justify-center gap-3">
            {c.contact_phone && (
              <a href={`tel:${c.contact_phone}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                <Phone className="h-4 w-4" /> {c.contact_phone}
              </a>
            )}
            {c.contact_phone && (
              <a href={`sms:${c.contact_phone}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                Text us
              </a>
            )}
            {c.contact_email && (
              <a href={`mailto:${c.contact_email}`} className="inline-flex items-center gap-1.5 hover:text-foreground">
                <Mail className="h-4 w-4" /> {c.contact_email}
              </a>
            )}
          </div>
        </footer>
      </div>

      {/* Sticky bottom tab bar */}
      <BottomTabs token={token} isCommercial={isCommercial} />
    </div>
  );
}

const TABS = [
  { to: "/portal/$token", label: "Home", icon: Home, end: true },
  { to: "/portal/$token/visits", label: "Visits", icon: CalendarDays, end: false },
  { to: "/portal/$token/billing", label: "Billing", icon: Receipt, end: false },
  { to: "/portal/$token/property", label: "Property", icon: MapPinIcon, end: false },
  { to: "/portal/$token/requests", label: "Requests", icon: MessageCircleWarning, end: false },
  { to: "/portal/$token/account", label: "Account", icon: User, end: false },
] as const;

function BottomTabs({ token, isCommercial }: { token: string; isCommercial: boolean }) {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  return (
    <nav aria-label="Portal sections"
      className="fixed inset-x-0 bottom-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto max-w-3xl">
        <ul className="grid grid-cols-6">
          {TABS.map((t) => {
            const target = t.to.replace("$token", token);
            const active = t.end ? pathname === target : pathname === target || pathname.startsWith(target + "/");
            const Icon = t.icon;
            const label = t.label === "Property" && isCommercial ? "Property" : t.label;
            return (
              <li key={t.to}>
                <Link to={t.to} params={{ token }}
                  className={`flex flex-col items-center gap-0.5 px-1 py-2 text-[10px] font-medium transition-colors ${
                    active ? "text-primary" : "text-muted-foreground hover:text-foreground"
                  }`}>
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
