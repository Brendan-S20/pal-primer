import { createFileRoute, Link, Outlet, useRouterState } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";

export const Route = createFileRoute("/_authenticated/settings")({
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
      { label: "Skip rules", to: "/settings/skip-rules" },
      { label: "Blackouts", to: "/settings/blackouts" },
      { label: "Add-ons", to: "/settings/addons" },
      { label: "Deep-clean", to: "/settings/deep-clean" },
    ],
  },
  {
    title: "Customer-facing",
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
      { label: "Refer a business", to: "/settings/referrals" },
      // BUILD-6: the child side of a franchise. Reachable by any plan on
      // purpose — a franchisee is a location someone else recruited, and
      // gating this behind Enterprise would make joining impossible for the
      // orgs that actually need to join.
      { label: "Franchise", to: "/settings/franchise" },
    ],
  },
  {
    title: "Communications",
    tabs: [
      { label: "SMS", to: "/settings/sms" },
      { label: "Emails", to: "/settings/emails" },
      { label: "AI Tools", to: "/settings/ai" },
      { label: "AI receptionist", to: "/settings/ai-receptionist" },
      { label: "Reviews", to: "/settings/reviews" },
      { label: "Automation", to: "/settings/automation" },
    ],
  },
  {
    title: "Financial",
    tabs: [
      { label: "Invoicing", to: "/settings/invoicing" },
      { label: "Billing", to: "/settings/billing" },
      { label: "Accounting", to: "/settings/accounting" },
    ],
  },
  {
    title: "Team",
    tabs: [{ label: "Users & roles", to: "/settings/users" }],
  },
];

function SettingsLayout() {
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const { role } = useMyRole();
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

  const [pickerOpen, setPickerOpen] = useState(false);
  // Close on navigation. The mobile app sidebar shipped without this and stayed
  // open over the page it had just navigated to; not repeating it here.
  useEffect(() => {
    setPickerOpen(false);
  }, [pathname]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">Configure how your business runs.</p>
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
      <div className="md:hidden">
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
      <nav aria-label="Settings sections" className="hidden space-y-2 border-b pb-3 md:block">
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
