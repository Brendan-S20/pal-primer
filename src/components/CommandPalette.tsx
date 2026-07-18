import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { supabase } from "@/integrations/supabase/client";
import { useMyRole, canAccess } from "@/hooks/useMyRole";

type NavEntry = { label: string; to: string; group: string };

const NAV: NavEntry[] = [
  { label: "Dashboard", to: "/dashboard", group: "Overview" },
  { label: "Leads", to: "/leads", group: "Overview" },
  { label: "Clients", to: "/clients", group: "Operations" },
  { label: "Zones", to: "/zones", group: "Operations" },
  { label: "Routes", to: "/routes", group: "Operations" },
  { label: "Weather", to: "/weather", group: "Operations" },
  { label: "My day", to: "/my-day", group: "Field" },
  { label: "Waste log", to: "/waste-log", group: "Field" },
  { label: "Messages", to: "/messages", group: "Field" },
  { label: "Inventory", to: "/inventory", group: "Ops" },
  { label: "Invoices", to: "/invoices", group: "Billing" },
  { label: "Payments", to: "/payments", group: "Billing" },
  { label: "Billing", to: "/settings/billing", group: "Settings" },
  { label: "Reports", to: "/reports", group: "Insights" },
  { label: "Analytics", to: "/analytics", group: "Insights" },
  // AI tools no longer have a standalone destination — surface the two
  // owner-facing ones (marketing + weekly digest) here as quick actions that
  // deep-link to the dashboard where they render, and point the workflow-bound
  // ones (review replies, churn, dispatch) at their in-context page so people
  // can jump straight to the work. AI zone pricing is intentionally hidden
  // (QA round 3 C5) — no entry for it here.
  { label: "AI: marketing content", to: "/dashboard", group: "AI" },
  { label: "AI: weekly digest", to: "/dashboard", group: "AI" },
  { label: "AI: review replies", to: "/settings/reviews", group: "AI" },
  { label: "AI: churn risk", to: "/clients", group: "AI" },
  { label: "AI: dispatch", to: "/routes", group: "AI" },
  { label: "Import", to: "/imports", group: "Setup" },
  { label: "Skip rules", to: "/settings/skip-rules", group: "Settings" },
  { label: "Blackouts", to: "/settings/blackouts", group: "Settings" },
  { label: "SMS", to: "/settings/sms", group: "Settings" },
  { label: "AI receptionist", to: "/settings/ai-receptionist", group: "Settings" },
  { label: "Automation", to: "/settings/automation", group: "Settings" },
  { label: "Emails", to: "/settings/emails", group: "Settings" },
  { label: "Reviews", to: "/settings/reviews", group: "Settings" },
  { label: "Add-ons", to: "/settings/addons", group: "Settings" },
  { label: "Accounting", to: "/settings/accounting", group: "Settings" },
];

type ClientHit = { id: string; name: string };

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [clients, setClients] = useState<ClientHit[]>([]);
  const navigate = useNavigate();
  const { role } = useMyRole();
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
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from("clients")
        .select("id,display_name")
        .ilike("display_name", `%${q}%`)
        .limit(6);
      if (!cancelled && data) {
        setClients(data.map((c) => ({ id: c.id, name: c.display_name ?? "(no name)" })));
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, open, canSearchClients]);

  const go = (to: string, params?: Record<string, string>) => {
    setOpen(false);
    setQuery("");
    navigate({ to, params } as never);
  };

  const groups = NAV.filter((item) => canAccess(role, item.to)).reduce<Record<string, NavEntry[]>>(
    (acc, item) => {
      (acc[item.group] ||= []).push(item);
      return acc;
    },
    {},
  );

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput
        placeholder="Jump to page or search clients…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>No results.</CommandEmpty>
        {clients.length > 0 && (
          <>
            <CommandGroup heading="Clients">
              {clients.map((c) => (
                <CommandItem
                  key={c.id}
                  value={`client-${c.id}-${c.name}`}
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
