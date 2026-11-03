// A client picker that searches on the server (#617).
//
// The New invoice and One-off visit dialogs used to fill a <select> with the
// whole roster. That read failed at about a thousand clients ("URI too long")
// and left both pickers empty, and a <select> of a thousand names is not a
// way to find anybody anyway. This asks searchClients for what was typed:
// name, phone (any punctuation), email, street, external id, accents ignored.
// With nothing typed it shows the first clients by name, so it is never blank.

import { useEffect, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { searchClients } from "@/lib/clients.functions";

export type PickedClient = {
  id: string;
  display_name: string;
  primary_email: string | null;
  primary_phone: string | null;
  active: boolean;
  street: string | null;
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function ClientSearchPicker({
  id,
  value,
  onChange,
  activeOnly = true,
  enabled = true,
}: {
  /** For a <label htmlFor>. */
  id?: string;
  value: PickedClient | null;
  onChange: (client: PickedClient | null) => void;
  activeOnly?: boolean;
  /** False while the dialog holding it is closed. */
  enabled?: boolean;
}) {
  const fn = useServerFn(searchClients);
  const [q, setQ] = useState("");
  const debounced = useDebounced(q.trim(), 200);
  const results = useQuery({
    queryKey: ["client-search", debounced, activeOnly],
    queryFn: () => fn({ data: { q: debounced, limit: 20, activeOnly } }),
    enabled: enabled && !value,
    placeholderData: keepPreviousData,
    staleTime: 30_000,
  });
  const hits = (results.data?.clients ?? []) as PickedClient[];

  if (value) {
    return (
      <div className="mt-1 flex min-h-10 items-center gap-2 rounded-md border bg-background py-1 ps-3 pe-1 text-sm touch:min-h-11">
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium">{value.display_name}</div>
          {(value.street || value.primary_email) && (
            <div className="truncate text-xs text-muted-foreground">
              {value.street ?? value.primary_email}
            </div>
          )}
        </div>
        <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)}>
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-1">
      <div className="relative">
        <Search className="pointer-events-none absolute start-2 top-1/2 h-4 w-4 shrink-0 -translate-y-1/2 text-muted-foreground" />
        <Input
          id={id}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search name, phone, email, address or ID"
          className="ps-8"
          autoComplete="off"
          role="combobox"
          aria-expanded="true"
          aria-controls={id ? `${id}-results` : undefined}
        />
      </div>
      <ul
        id={id ? `${id}-results` : undefined}
        role="listbox"
        className="mt-1 max-h-56 overflow-y-auto rounded-md border bg-background"
      >
        {results.isLoading ? (
          <li className="px-3 py-2 text-sm text-muted-foreground">Loading clients…</li>
        ) : results.isError ? (
          <li className="px-3 py-2 text-sm text-destructive">
            Could not load clients. {(results.error as Error).message}
          </li>
        ) : hits.length === 0 ? (
          <li className="px-3 py-2 text-sm text-muted-foreground">
            {debounced ? "No client matches that." : "No clients yet."}
          </li>
        ) : (
          hits.map((c) => (
            <li key={c.id} role="option" aria-selected="false">
              <button
                type="button"
                className="flex min-h-10 w-full flex-col items-start justify-center px-3 py-1.5 text-start text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none touch:min-h-11"
                onClick={() => {
                  onChange(c);
                  setQ("");
                }}
              >
                <span className="w-full truncate font-medium">{c.display_name || "(no name)"}</span>
                {(c.street || c.primary_email || c.primary_phone) && (
                  <span className="w-full truncate text-xs text-muted-foreground">
                    {[c.street, c.primary_email ?? c.primary_phone].filter(Boolean).join(" · ")}
                  </span>
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}
