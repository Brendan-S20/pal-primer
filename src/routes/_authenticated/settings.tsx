import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => titleHead("Settings"),
  component: SettingsLayout,
});

type Tab = { label: string; to: string; techVisible?: boolean };
type TabGroup = { title: string; tabs: Tab[] };

// Grouped to match the main app sidebar's high-level buckets.
const TAB_GROUPS: TabGroup[] = [
  {
    title: "Business setup",
    tabs: [
      { label: "Preferences", to: "/settings/preferences", techVisible: true },
      { label: "Scheduling", to: "/settings/scheduling" },
      // Prices live on zones, and a first-time owner looking for "how much do
      // I charge" opened Settings and did not find them (persona review,
      // 2026-09-27). The page itself stays where the sidebar has it.
      { label: "Zones & pricing", to: "/zones" },
      { label: "Skip rules", to: "/settings/skip-rules" },
      { label: "Blackouts", to: "/settings/blackouts" },
      { label: "Add-ons", to: "/settings/addons" },
      { label: "Deep clean", to: "/settings/deep-clean" },
    ],
  },
  {
    title: "Client-facing",
    tabs: [
      // The portal is the first thing a customer meets, so it sits at the top
      // of the group that is about them. It was under Preferences until
      // 2026-08-28, which is where a reader looking for a brand colour would
      // never have thought to go.
      { label: "Client portal", to: "/settings/client-portal" },
      { label: "Lead form", to: "/settings/lead-form" },
      // The two gates on /signup/{slug} had no UI at all, which is why the
      // whole public signup flow shipped unreachable. Sits next to Lead form
      // because they are the same decision seen from two sides: capture the
      // stranger's details, or let the stranger buy.
      { label: "Online signup", to: "/settings/online-signup" },
      { label: "Promotions", to: "/settings/promotions" },
      // Moved from Communications (launch pass, 2026-10). The page is
      // "Reviews & referrals": the Google review link customers are sent to
      // and the reward a customer earns for referring a neighbour, both
      // things the customer sees, so they sit beside Promotions. The label
      // now matches the page's own heading.
      { label: "Reviews & referrals", to: "/settings/reviews" },
    ],
  },
  {
    title: "Communications",
    tabs: [
      { label: "SMS", to: "/settings/sms" },
      { label: "Emails", to: "/settings/emails" },
      { label: "AI receptionist", to: "/settings/ai-receptionist" },
      { label: "Automation", to: "/settings/automation" },
    ],
  },
  {
    title: "Financial",
    tabs: [
      { label: "Invoicing", to: "/settings/invoicing" },
      { label: "Accounting", to: "/settings/accounting" },
    ],
  },
  {
    // Outbound webhooks, so a business can send its events to Zapier, Make,
    // n8n or its own systems. Its own group rather than under Financial:
    // most of what people connect is not money (new clients to a mailing
    // list, completed visits to a review tool).
    //
    // Labelled by the thing an owner has heard of. Nobody running two trucks
    // goes looking for "Webhooks"; they go looking for how to hook this up to
    // Zapier, and the page's own first sentence names Zapier, Make and n8n.
    title: "Integrations",
    tabs: [{ label: "Zapier & webhooks", to: "/settings/webhooks" }],
  },
  {
    title: "Team",
    tabs: [{ label: "Users & roles", to: "/settings/users" }],
  },
  {
    // ── THE BUSINESS'S OWN ACCOUNT WITH HOUNDSTACK ──────────────────────────
    //
    // Until the launch pass (2026-10) these four were scattered. "Billing" sat
    // under Financial beside Invoicing: two words for money, where one is what
    // you charge your customers and the other is what HoundStack charges you.
    // "Refer a business" and "Franchise" sat under Customer-facing, although
    // no customer ever sees either. All four are about this business's
    // relationship with HoundStack, so they are one group.
    //
    // "Plan & billing" is also what onboarding and the plan picker already
    // told people to look for, in a rail that said "Billing". "AI usage"
    // because that is what the page shows (the monthly allowance, the ceiling,
    // what has been spent); there are no tools on it to configure.
    //
    // tests/a-signpost-names-a-real-setting.test.ts holds every
    // "Settings → X" in the product's copy to a label in this list.
    title: "Your HoundStack account",
    tabs: [
      { label: "Plan & billing", to: "/settings/billing" },
      { label: "AI usage", to: "/settings/ai" },
      { label: "Refer a business", to: "/settings/referrals" },
      // BUILD-6: the child side of a franchise. Reachable by any plan on
      // purpose — a franchisee is a location someone else recruited, and
      // gating this behind Enterprise would make joining impossible for the
      // orgs that actually need to join.
      { label: "Franchise", to: "/settings/franchise" },
    ],
  },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role } = useMyRole();
  // Only the heading follows the interface language. A tech reaches exactly
  // one section, their own Preferences, which is translated; the section
  // picker below is office-only and stays in English with the screens it
  // opens.
  const { t } = useTranslation();
  const groups = TAB_GROUPS.map((g) => ({
    ...g,
    // Hide tabs the role can't open — showing a link that bounces to the
    // dashboard with "You don't have access" reads as broken (P1.4).
    tabs: g.tabs.filter((t) => (role !== "tech" || t.techVisible) && canAccess(role, t.to)),
  })).filter((g) => g.tabs.length > 0);
  // Which tab is open, so the phone switcher can name it instead of making
  // somebody open a menu to find out where they already are.
  const current = groups
    .flatMap((g) => g.tabs.map((t) => ({ ...t, group: g.title })))
    .find((t) => pathname === t.to || pathname.startsWith(t.to + "/"));

  // A tech reaches exactly one section, their own Preferences. A picker
  // headed "Business setup" holding one choice is a control that does
  // nothing, wearing a label about a business they do not run, so with one
  // section there is no picker and no rail: the page's own heading says
  // where you are.
  const sectionCount = groups.reduce((n, g) => n + g.tabs.length, 0);
  const oneSection = sectionCount <= 1;

  const [pickerOpen, setPickerOpen] = useState(false);
  // Close on navigation. The mobile app sidebar shipped without this and stayed
  // open over the page it had just navigated to; not repeating it here.
  useEffect(() => {
    setPickerOpen(false);
  }, [pathname]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("settings.title")}</h1>
        <p className="text-sm text-muted-foreground">
          {oneSection ? t("settings.subtitleOneSection") : t("settings.subtitle")}
        </p>
      </div>

      {/* ── PHONE: ONE ROW INSTEAD OF TWENTY-ONE ────────────────────────────
          The rail below renders all 21 tabs at once. Measured at 360px on
          2026-08-25 that is 601px of navigation starting at y=365, so the first
          actual setting begins around y=990 in a 780px viewport — you scroll
          past a full screen of menu on every settings page, having already
          chosen the page.

          The group label made it worse rather than better: `w-36` is 144px, 40%
          of a 360px row, so one chip fits beside it and the rest wrap
          underneath. The rendering read as "BUSINESS SETUP  Preferences" then
          unrelated chips, which is not a group, it is a ransom note.

          So on a phone this collapses to what the user actually needs: where am
          I, and how do I get somewhere else. The sheet is the same idiom as the
          tab bar's More sheet, which is the one sheet in this app that already
          got safe-area padding and a real close control right. */}
      <div className={oneSection ? "hidden" : "md:hidden"}>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          className="flex min-h-11 w-full items-center justify-between gap-3 rounded-md border bg-card px-3 text-left"
        >
          <span className="min-w-0">
            <span className="block text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              {current?.group ?? "Settings"}
            </span>
            <span className="block truncate text-sm font-medium">
              {current?.label ?? "Choose a section"}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>

        <Sheet open={pickerOpen} onOpenChange={setPickerOpen}>
          <SheetContent
            side="bottom"
            className="max-h-[80dvh] overflow-y-auto rounded-t-xl pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
          >
            <SheetHeader className="text-left">
              <SheetTitle>Settings</SheetTitle>
            </SheetHeader>
            <div className="mt-2 space-y-4">
              {groups.map((group) => (
                <div key={group.title}>
                  {/* The label is a heading on its own line here, so it stops
                      competing with the first chip for the same row. */}
                  <div className="px-1 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.title}
                  </div>
                  <div className="space-y-0.5">
                    {group.tabs.map((tab) => {
                      const active = pathname === tab.to || pathname.startsWith(tab.to + "/");
                      return (
                        <Link
                          key={tab.to}
                          to={tab.to}
                          className={`flex min-h-11 items-center rounded-md px-3 text-sm ${
                            active ? "bg-primary/10 font-medium text-primary" : "text-foreground"
                          }`}
                        >
                          {tab.label}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </SheetContent>
        </Sheet>
      </div>

      {/* ── TABLET AND UP: the grouped rail, unchanged in behaviour ───────── */}
      <nav
        aria-label="Settings sections"
        className={oneSection ? "hidden" : "hidden space-y-2 border-b pb-3 md:block"}
      >
        {groups.map((group) => (
          <div key={group.title} className="flex flex-wrap items-baseline gap-1">
            <span className="w-36 shrink-0 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
              {group.title}
            </span>
            {group.tabs.map((tab) => {
              const active = pathname === tab.to || pathname.startsWith(tab.to + "/");
              return (
                <Link
                  key={tab.to}
                  to={tab.to}
                  // MEASURED 2026-08-19: 28.0px, twenty-one of them, on EVERY settings
                  // page — the single highest-count finding in the sweep. The fix is
                  // height only; `inline-flex items-center` keeps the label
                  // centred once the box is taller than the text.
                  //
                  // The note here used to say "the rail already scrolls sideways in
                  // its own container". It does not, and never did — measured
                  // 2026-08-25 it is `overflow-x: visible` with `flex-wrap: wrap`,
                  // so it wrapped to 601px tall instead of scrolling. That claim is
                  // why the height-only fix looked sufficient at the time. This rail
                  // is now `md:block` only, and the phone case is the switcher above.
                  className={`inline-flex items-center rounded-md px-3 py-1 text-sm transition-colors touch:min-h-11 ${
                    active
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {tab.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
      <div>
        <Outlet />
      </div>
    </div>
  );
}
