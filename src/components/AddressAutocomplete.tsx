// Debounced, keyboard-accessible address autocomplete backed by the
// server-side AddressProvider proxy (Google Places New today). Falls back
// to a plain text input when no provider is configured, so manual entry
// always works. Selecting a suggestion resolves full details (structured
// address + coordinates + detected zone) through the backend.
import { useEffect, useId, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, MapPin } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  /** Who produced address.latitude/longitude (geocode-source.ts). */
  geocodeSource?: "google_places" | null;
}

/** What the control renders, given its state.
 *
 *  This is a value rather than four inline `&&`s in the JSX because the
 *  no-provider branch is the ONLY branch anyone sees until a provider is
 *  configured, and `npm test` runs vitest in the node environment — there is
 *  no jsdom in this repo — so a rendered assertion is not available. The
 *  alternative was matching the shape of the source text, which passes just as
 *  happily when the guard has been deleted and the class list is unchanged.
 *  See RouteMap.tsx for the same reasoning about the same constraint. */
export interface AddressControlState {
  /** Is the suggestion dropdown rendered at all? */
  listbox: boolean;
  /** Is the in-field spinner rendered? A spinner with no provider behind it
   *  is a wait that never ends. */
  spinner: boolean;
  /** A combobox only when there is actually a popup to announce. */
  role: "combobox" | undefined;
  /** `aria-expanded` on something with no combobox role makes a screen reader
   *  announce "collapsed" on a plain text field. Undefined means unset. */
  ariaExpanded: boolean | undefined;
  /** Always true. Typing an address by hand is the floor this control stands
   *  on, not a fallback it drops to — every state above is additive. */
  editable: true;
}

export function addressControlState(s: {
  enabled: boolean;
  open: boolean;
  suggestionCount: number;
  searching: boolean;
  resolving: boolean;
}): AddressControlState {
  // Everything the provider drives hangs off `enabled` in one place: with no
  // provider there is nothing to open, nothing to wait for and no popup to
  // announce. What is left is an ordinary text input.
  const live = s.enabled;
  return {
    listbox: live && s.open && s.suggestionCount > 0,
    spinner: live && (s.searching || s.resolving),
    role: live ? "combobox" : undefined,
    ariaExpanded: live ? s.open : undefined,
    editable: true,
  };
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
  disabled,
  maxLength,
  className,
  ariaInvalid,
}: {
  id?: string;
  value: string;
  onChangeText: (text: string) => void;
  onResolved: (r: ResolvedAddress) => void;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
  /** Passed through to the input, so a form that marks a missing address in
   *  red keeps doing so after it swaps its <Input> for this. */
  className?: string;
  ariaInvalid?: boolean;
}) {
  const { t } = useTranslation();
  const listId = useId();
  const statusFn = useServerFn(addressSearchStatus);
  const autocompleteFn = useServerFn(autocompleteAddress);
  const resolveFn = useServerFn(resolveAddress);

  const { data: status } = useQuery({
    queryKey: ["address-search-status"],
    queryFn: () => statusFn(),
    staleTime: 5 * 60 * 1000,
    // No provider is configured, so this call answers `{enabled:false}` and
    // will keep doing so; and on any surface without a staff session it
    // rejects outright (the server fn is behind requireSupabaseAuth). Neither
    // is worth three retries with backoff on every mount of every address
    // form. A rejection leaves `status` undefined, which is the same answer as
    // a "no" — the control degrades to manual entry either way.
    retry: false,
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

  // One decision, taken once, for what this control shows. See
  // addressControlState above for why it is a value and not four inline
  // guards in the JSX below.
  const ui = addressControlState({
    enabled,
    open,
    suggestionCount: suggestions.length,
    searching,
    resolving,
  });

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Input
          id={id}
          value={value}
          className={className}
          disabled={disabled}
          maxLength={maxLength}
          aria-invalid={ariaInvalid}
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Abandoned search: end the billing session so the next search
            // starts a fresh token instead of riding an expired one.
            if (!resolving) sessionToken.current = "";
          }}
          placeholder={placeholder ?? (enabled ? t("address.placeholder") : undefined)}
          required={required}
          autoComplete="off"
          role={ui.role}
          aria-expanded={ui.ariaExpanded}
          aria-controls={enabled ? listId : undefined}
          aria-autocomplete={enabled ? "list" : undefined}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        />
        {ui.spinner && (
          <Loader2 className="absolute end-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground shrink-0" />
        )}
      </div>

      {ui.listbox && (
        <ul
          id={listId}
          role="listbox"
          // `w-full` and not a fixed width: this hangs over a form column that
          // is 328px wide on a 360px phone, and a `w-80` popover there is off
          // the side of the screen. max-h caps it at roughly five rows so the
          // list scrolls itself instead of the page.
          className="absolute z-50 mt-1 max-h-64 w-full overflow-y-auto overscroll-contain rounded-md border bg-popover p-1 shadow-md"
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
              // min-h-11 is 44px. This row is the whole point of the control on
              // a phone in a driveway, and at py-1.5 it was a 30px target
              // sitting 6px from the next one. The highlight is driven by
              // `active`, which the arrow keys set as well as the pointer, so
              // the list is not hover-only.
              className={`flex min-h-11 cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-sm ${
                i === active ? "bg-accent text-accent-foreground" : ""
              }`}
            >
              <MapPin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              {/* min-w-0 + wrapping: a 40-character address must wrap inside
                  the row rather than set the row's width and push the pin off
                  the edge. */}
              <span className="min-w-0 break-words">
                <span className="font-medium">{s.mainText}</span>
                {s.secondaryText && (
                  <span className="ms-1 text-muted-foreground">{s.secondaryText}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
