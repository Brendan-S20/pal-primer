import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getDeepCleanSettings } from "@/lib/subscriptions.functions";
import { ChevronDown } from "lucide-react";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { useTranslation } from "react-i18next";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { titleHead } from "@/lib/page-title";
import { useServiceLines } from "@/components/CommercialOnly";

export const Route = createFileRoute("/_authenticated/settings")({
  head: () => titleHead("Settings"),
  component: SettingsLayout,
});

/** `petWasteOnly`: hidden from a business that does not run pet waste
 *  (organizations.service_lines), like NavItem.petWasteOnly in the sidebar.
 *  The page stays routable; only the signpost goes. */
type Tab = { label: string; to: string; techVisible?: boolean; petWasteOnly?: boolean };
type TabGroup = { title: string; tabs: Tab[] };

// Grouped to match the main app sidebar's high-level buckets.
const TAB_GROUPS: TabGroup[] = [
  {
    title: "Business setup",
    tabs: [
      // Preferences is THIS DEVICE (language, light or dark, haptics, the
      // phone menu) and is the one section a technician sees. Business
      // defaults is what the whole business uses and was on the same page
      // until 2026-10-02, which is why an owner could not tell the two kinds
      // of switch apart.
      { label: "Preferences", to: "/settings/preferences", techVisible: true },
      { label: "Business defaults", to: "/settings/business" },
      { label: "Scheduling", to: "/settings/scheduling" },
      // Prices live on zones, and a first-time owner looking for "how much do
      // I charge" opened Settings and did not find them (persona review,
      // 2026-09-27). The page itself stays where the sidebar has it.
      { label: "Zones & pricing", to: "/zones" },
      // What the business sells: a walk, a sit, a groom, pet waste removal
      // (docs/other-trades-service-catalog.md, phase 1). Beside zones,
      // because both answer "what do I charge".
      { label: "Services", to: "/settings/services" },
      { label: "Skip rules", to: "/settings/skip-rules" },
      { label: "Blackouts", to: "/settings/blackouts" },
      { label: "Add-ons", to: "/settings/addons" },
      { label: "Deep clean", to: "/settings/deep-clean", petWasteOnly: true },
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
      // ONE entry since 2026-10-08. "Lead form" and "Online signup" were two
      // settings pages for two public forms that asked a stranger the same
      // questions; the forms are one now (/signup/{slug}, which prices the
      // yard and lets the visitor start service or ask for a quote) and so
      // are their settings. /settings/lead-form forwards here.
      { label: "Signup & quote form", to: "/settings/online-signup" },
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
      { label: "Texting", to: "/settings/sms" },
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
  const { petWaste } = useServiceLines();
  // A pet-waste-only section stays signposted while it is still doing
  // something. The seasonal deep clean adds a charge to real invoices when it
  // is on, so a business that has switched pet waste off but left that on
  // must still be able to find the switch. Asked only when it matters, and
  // under the key the Deep clean page itself uses, so it is one fetch.
  const deepCleanFn = useServerFn(getDeepCleanSettings);
  const deepClean = useQuery({
    queryKey: ["deep-clean"],
    queryFn: () => deepCleanFn(),
    enabled: !petWaste && role !== "tech" && canAccess(role, "/settings/deep-clean"),
    staleTime: 60_000,
    retry: false,
  });
  const stillInUse = (to: string) =>
    to === "/settings/deep-clean" && deepClean.data?.enabled === true;
  // Only the heading follows the interface language. A tech reaches exactly
  // one section, their own Preferences, which is translated; the section
  // picker below is office-only and stays in English with the screens it
  // opens.
  const { t } = useTranslation();
  const groups = TAB_GROUPS.map((g) => ({
    ...g,
    // Hide tabs the role can't open — showing a link that bounces to the
    // dashboard with "You don't have access" reads as broken (P1.4).
    tabs: g.tabs.filter(
      (t) =>
        (role !== "tech" || t.techVisible) &&
        canAccess(role, t.to) &&
        (!t.petWasteOnly || petWaste || stillInUse(t.to)),
    ),
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
  // The open section in view inside the menu's own scroller: the sideways
  // row on a tablet, the side column on a short laptop screen. "nearest"
  // moves nothing that is already visible, the page included.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    navRef.current
      ?.querySelector<HTMLElement>('[data-active="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [pathname]);

  return (
    <>
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

      {/* ── TABLET AND UP (QA row 36, 2026-10-15) ───────────────────────────
          This was a cloud of about thirty wrapping chips above the content,
          around 500px of navigation on an iPad before the first setting.
          Now one <nav> in two shapes:

            * 768 to 1023: a single row that scrolls sideways in its own
              container, group headings dropped and groups divided by a rule.
              One row of height, whatever the number of sections.
            * 1024 and up: a grouped vertical menu in a side column beside
              the content. It sticks under the header and scrolls on its own
              when it is taller than the screen.

          Below 768 the picker above is unchanged. */}
      <div
        className={
          oneSection
            ? ""
            : "space-y-6 lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8 lg:space-y-0"
        }
      >
        <nav
          ref={navRef}
          aria-label="Settings sections"
          className={
            oneSection
              ? "hidden"
              : "relative hidden overflow-x-auto border-b pb-2 md:block lg:sticky lg:top-[calc(var(--hs-banner-h,0px)+4.5rem)] lg:max-h-[calc(100dvh-var(--hs-banner-h,0px)-5.5rem)] lg:overflow-y-auto lg:overflow-x-hidden lg:border-b-0 lg:border-e lg:pb-0 lg:pe-3"
          }
        >
          <div className="flex w-max gap-1 lg:w-auto lg:flex-col lg:gap-4">
            {groups.map((group, i) => (
              <div
                key={group.title}
                className={`flex shrink-0 items-center gap-1 lg:flex-col lg:items-stretch lg:gap-0.5 ${
                  i > 0 ? "max-lg:border-s max-lg:ps-1" : ""
                }`}
              >
                <span className="px-3 pb-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground max-lg:hidden">
                  {group.title}
                </span>
                {group.tabs.map((tab) => {
                  const active = pathname === tab.to || pathname.startsWith(tab.to + "/");
                  return (
                    <Link
                      key={tab.to}
                      to={tab.to}
                      data-active={active ? "true" : undefined}
                      aria-current={active ? "page" : undefined}
                      // MEASURED 2026-08-19: 28.0px, twenty-one of them, on
                      // EVERY settings page. `touch:min-h-11` is the fix, and
                      // `inline-flex items-center` keeps the label centred once
                      // the box is taller than the text. `whitespace-nowrap` so
                      // a label in the sideways row never wraps to two lines.
                      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-md px-3 py-1 text-sm transition-colors touch:min-h-11 lg:whitespace-normal ${
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
          </div>
        </nav>
        <div className="min-w-0">
          <Outlet />
        </div>
      </div>
    </>
  );
}
