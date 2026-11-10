import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { searchClients } from "@/lib/clients.functions";
import { useMyRole, canAccess } from "@/hooks/useMyRole";
import { useClientTexting } from "@/hooks/useClientTexting";
import { useServiceLines } from "@/components/CommercialOnly";

/** `petWasteOnly`: hidden for a business that does not run pet waste, as in
 *  the sidebar (NavItem.petWasteOnly). */
type NavEntry = {
  label: string;
  to: string;
  group: string;
  petWasteOnly?: boolean;
  /** Only once this business can text its clients (NavItem.textingOnly). */
  textingOnly?: boolean;
};

const NAV: NavEntry[] = [
  { label: "Dashboard", to: "/dashboard", group: "Overview" },
  { label: "Leads", to: "/leads", group: "Overview" },
  { label: "Clients", to: "/clients", group: "Operations" },
  { label: "Zones", to: "/settings/zones", group: "Operations" },
  { label: "Rate card drift", to: "/pricing-drift", group: "Insights" },
  // "Schedule" for /routes, matching the mobile tab bar and the sidebar. The
  // URL stays as it is; the label is what a person searches for, and there is
  // no `routes` table behind it to justify the older word.
  { label: "Schedule", to: "/routes", group: "Operations" },
  { label: "My day", to: "/my-day", group: "Field" },
  { label: "Waste log", to: "/waste-log", group: "Field", petWasteOnly: true },
  { label: "Inbox", to: "/inbox", group: "Overview" },
  { label: "Messages", to: "/messages", group: "Operations", textingOnly: true },
  // "Operations", as in the sidebar. These were a separate "Ops" group there
  // and here, the same word twice.
  { label: "Inventory", to: "/inventory", group: "Operations" },
  { label: "Timesheets", to: "/timesheets", group: "Operations" },
  { label: "Invoices", to: "/invoices", group: "Billing" },
  { label: "Quotes", to: "/quotes", group: "Billing" },
  { label: "Payments", to: "/payments", group: "Billing" },
  { label: "Plan & billing", to: "/settings/billing", group: "Settings" },
  { label: "Reports", to: "/reports", group: "Insights" },
  // Reports' other two tabs keep their own entries here: the palette is
  // searched by name, and "tax" or "analytics" should still find them.
  { label: "Analytics", to: "/analytics", group: "Insights" },
  { label: "Tax & accountant", to: "/tax-reports", group: "Insights" },
  // The office tools have no standalone destination. Surface the
  // owner-facing one (weekly digest) as a quick action that deep-links to the
  // dashboard where it renders, and point the workflow-bound ones (review
  // replies, churn) at their in-context page. Zone pricing is intentionally
  // hidden (QA round 3 C5). These sat in an "AI" group until 2026-10-03, when
  // they stopped using AI; "AI: dispatch" went with the dispatch panel, and
  // marketing posts get an entry back when they launch (ai-launch.ts).
  { label: "Weekly digest", to: "/dashboard", group: "Insights" },
  { label: "Review replies", to: "/settings/reviews", group: "Operations" },
  { label: "Churn risk", to: "/clients", group: "Insights" },
  { label: "Import", to: "/imports", group: "Setup" },
  { label: "Skip rules", to: "/settings/skip-rules", group: "Settings" },
  { label: "Blackouts", to: "/settings/blackouts", group: "Settings" },
  { label: "Texting", to: "/settings/sms", group: "Settings" },
  { label: "AI receptionist", to: "/settings/ai-receptionist", group: "Settings" },
  { label: "Automation", to: "/settings/automation", group: "Settings" },
  { label: "Emails", to: "/settings/emails", group: "Settings" },
  { label: "Business defaults", to: "/settings/business", group: "Settings" },
  { label: "Reviews & referrals", to: "/settings/reviews", group: "Settings" },
  { label: "Add-ons", to: "/settings/addons", group: "Settings" },
  { label: "Services", to: "/settings/services", group: "Settings" },
  { label: "Accounting", to: "/settings/accounting", group: "Settings" },
  { label: "Zapier & webhooks", to: "/settings/webhooks", group: "Settings" },
  // Yours, not the company's — hence its own group rather than sitting among
  // the org settings a technician cannot open.
  { label: "Your account", to: "/profile", group: "Account" },
];

type ClientHit = { id: string; name: string };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<ClientHit[]>([]);
  const [searchFailed, setSearchFailed] = useState(false);
  const searchFn = useServerFn(searchClients);
  const navigate = useNavigate();
  const { role } = useMyRole();
  const { petWaste } = useServiceLines();
  const texting = useClientTexting();
  // Don't surface client results to roles that can't open a client page
  // (e.g. Technician) — searching used to confirm a client exists and then
  // dead-click back to My day with no explanation (finding #50).
  const canSearchClients = canAccess(role, "/clients");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!open || q.length < 2 || !canSearchClients) {
      setClients([]);
      setSearchFailed(false);
      return;
    }
    let cancelled = false;
    // On the server, by the rule the /clients search uses (#617): name,
    // company, email, street, tags and import id with case and accents
    // ignored, and a phone number by its digits. This used to match the
    // display name alone, so "jose" missed "José" and a phone number or a
    // Jobber id found nobody.
    const t = setTimeout(async () => {
      try {
        const r = await searchFn({ data: { q, limit: 6 } });
        if (!cancelled) {
          setSearchFailed(false);
          setClients(r.clients.map((c) => ({ id: c.id, name: c.display_name || "(no name)" })));
        }
      } catch {
        // A failed search is not an empty one (#617): "No results" would tell
        // the owner the client does not exist.
        if (!cancelled) {
          setClients([]);
          setSearchFailed(true);
        }
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open, canSearchClients, searchFn]);

  const go = (to: string, params?: Record<string, string>) => {
    setOpen(false);
    setQuery("");
    navigate({ to, params } as never);
  };

  const groups = NAV.filter(
    (item) =>
      canAccess(role, item.to) &&
      (!item.petWasteOnly || petWaste) &&
      (!item.textingOnly || texting),
  ).reduce<Record<string, NavEntry[]>>((acc, item) => {
    (acc[item.group] ||= []).push(item);
    return acc;
  }, {});

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Jump to page or search clients…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {searchFailed && (
          <CommandGroup heading="Clients">
            <CommandItem
              value="client-search-failed"
              keywords={[query]}
              disabled
              data-testid="client-search-failed"
            >
              Search failed. Check your connection and try again.
            </CommandItem>
          </CommandGroup>
        )}
        {clients.length > 0 && (
          <>
            <CommandGroup heading="Clients">
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`client-${c.id}-${c.name}`}
                  // The server already matched these, on fields the palette
                  // cannot see (a phone number, an import id). Without the
                  // query as a keyword cmdk's own filter hid them again.
                  keywords={[query]}
                  onSelect={() => go("/clients/$clientId", { clientId: c.id })}
                >
                  {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        )}
        {Object.entries(groups).map(([label, items]) => (
          <CommandGroup key={label} heading={label}>
            {items.map((item) => (
              <CommandItem
                key={item.to}
                value={`${label} ${item.label}`}
                onSelect={() => go(item.to)}
              >
                {item.label}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  );
}
