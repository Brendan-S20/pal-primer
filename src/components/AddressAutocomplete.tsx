// Debounced, keyboard-accessible address autocomplete backed by the
// server-side AddressProvider proxy (Google Places New today). Falls back
// to a plain text input when no provider is configured, so manual entry
// always works. Selecting a suggestion resolves full details (structured
// address + coordinates + detected zone) through the backend.
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, MapPin } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  addressSearchStatus,
  autocompleteAddress,
  resolveAddress,
} from "@/lib/address.functions";
import type { AddressDetails } from "@/lib/address/provider.server";

export interface ResolvedAddress {
  address: AddressDetails;
  zoneId: string | null;
  zoneName: string | null;
}

const DEBOUNCE_MS = 300;
const MIN_CHARS = 3;

export function AddressAutocomplete({
  id,
  value,
  onChangeText,
  onResolved,
  placeholder,
  required,
}: {
  id?: string;
  value: string;
  onChangeText: (text: string) => void;
  onResolved: (r: ResolvedAddress) => void;
  placeholder?: string;
  required?: boolean;
}) {
  const listId = useId();
  const statusFn = useServerFn(addressSearchStatus);
  const autocompleteFn = useServerFn(autocompleteAddress);
  const resolveFn = useServerFn(resolveAddress);

  const { data: status } = useQuery({
    queryKey: ["address-search-status"],
    queryFn: () => statusFn(),
    staleTime: 5 * 60 * 1000,
  });
  const enabled = !!status?.enabled;

  const [suggestions, setSuggestions] = useState<
    Array<{ id: string; mainText: string; secondaryText: string }>
  >([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [resolving, setResolving] = useState(false);
  // One billing session per focus->select cycle.
  const sessionToken = useRef<string>("");
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);

  function ensureSession() {
    if (!sessionToken.current) sessionToken.current = crypto.randomUUID();
    return sessionToken.current;
  }

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  // Close when clicking outside.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function handleInput(text: string) {
    onChangeText(text);
    if (!enabled) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    if (text.trim().length < MIN_CHARS) {
      // Invalidate any in-flight request so its late response can't reopen
      // the list with suggestions for the longer, now-deleted query.
      requestSeq.current++;
      setSearching(false);
      setSuggestions([]);
      setOpen(false);
      return;
    }
    debounceTimer.current = setTimeout(async () => {
      const seq = ++requestSeq.current;
      setSearching(true);
      try {
        const r = await autocompleteFn({
          data: { query: text.trim(), sessionToken: ensureSession() },
        });
        if (seq !== requestSeq.current) return; // stale response
        setSuggestions(r.suggestions ?? []);
        setOpen((r.suggestions ?? []).length > 0);
        setActive(-1);
      } catch {
        if (seq === requestSeq.current) {
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (seq === requestSeq.current) setSearching(false);
      }
    }, DEBOUNCE_MS);
  }

  async function select(s: { id: string; mainText: string }) {
    // Kill the pending debounce and any in-flight search: a keystroke less
    // than 300ms before the click must not reopen the list (or bill a whole
    // new Google session) after the form is already filled.
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    requestSeq.current++;
    setSearching(false);
    setOpen(false);
    setResolving(true);
    try {
      const r = await resolveFn({
        data: { placeId: s.id, sessionToken: ensureSession() },
      });
      sessionToken.current = ""; // session ends at details
      onResolved(r as ResolvedAddress);
    } catch (e) {
      // Details failed: keep whatever text is typed; manual entry still works.
      onChangeText(s.mainText);
      console.warn("address resolve failed", e);
    } finally {
      setResolving(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || suggestions.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => (a + 1) % suggestions.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => (a <= 0 ? suggestions.length - 1 : a - 1));
    } else if (e.key === "Enter") {
      if (active >= 0) {
        e.preventDefault();
        void select(suggestions[active]);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          value={value}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Abandoned search: end the billing session so the next search
            // starts a fresh token instead of riding an expired one.
            if (!resolving) sessionToken.current = "";
          }}
          placeholder={placeholder ?? (enabled ? "Start typing an address…" : undefined)}
          required={required}
          autoComplete="off"
          role={enabled ? "combobox" : undefined}
          aria-expanded={open}
          aria-controls={enabled ? listId : undefined}
          aria-autocomplete={enabled ? "list" : undefined}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        />
        {(searching || resolving) && (
          <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
        )}
      </div>

      {enabled && open && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {suggestions.map((s, i) => (
            <li
              key={s.id}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                void select(s);
              }}
              className={`flex cursor-pointer items-start gap-2 rounded-sm px-2 py-1.5 text-sm ${
                i === active ? "bg-accent text-accent-foreground" : ""
              }`}
            >
              <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span>
                <span className="font-medium">{s.mainText}</span>
                {s.secondaryText && (
                  <span className="ml-1 text-muted-foreground">{s.secondaryText}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
