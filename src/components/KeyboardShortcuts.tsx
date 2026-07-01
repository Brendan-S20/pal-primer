import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";

const SHORTCUTS: Array<{ keys: string; label: string; to: string }> = [
  { keys: "g d", label: "Dashboard", to: "/dashboard" },
  { keys: "g c", label: "Clients", to: "/clients" },
  { keys: "g m", label: "My day", to: "/my-day" },
  { keys: "g r", label: "Routes", to: "/routes" },
  { keys: "g w", label: "Weather", to: "/weather" },
  { keys: "g i", label: "Invoices", to: "/invoices" },
  { keys: "g l", label: "Leads", to: "/leads" },
];

/**
 * Global keyboard shortcuts (gmail-style two-key jumps + "?" for help).
 * Ignores keystrokes while the user is typing in an input.
 */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const [helpOpen, setHelpOpen] = useState(false);

  useEffect(() => {
    let pendingG = false;
    let gTimer: ReturnType<typeof setTimeout> | null = null;

    const isTyping = (el: EventTarget | null) => {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (isTyping(e.target)) return;

      if (e.key === "?") {
        e.preventDefault();
        setHelpOpen((v) => !v);
        return;
      }
      if (e.key === "Escape" && helpOpen) {
        setHelpOpen(false);
        return;
      }
      if (e.key === "g") {
        pendingG = true;
        if (gTimer) clearTimeout(gTimer);
        gTimer = setTimeout(() => (pendingG = false), 1200);
        return;
      }
      if (pendingG) {
        pendingG = false;
        if (gTimer) clearTimeout(gTimer);
        const match = SHORTCUTS.find((s) => s.keys.endsWith(e.key));
        if (match) {
          e.preventDefault();
          navigate({ to: match.to });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (gTimer) clearTimeout(gTimer);
    };
  }, [navigate, helpOpen]);

  if (!helpOpen) return null;
  return (
    <div
      role="dialog"
      aria-label="Keyboard shortcuts"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={() => setHelpOpen(false)}
    >
      <div
        className="w-full max-w-sm rounded-lg border bg-card p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold">Keyboard shortcuts</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {SHORTCUTS.map((s) => (
            <li key={s.keys} className="flex items-center justify-between">
              <span className="text-muted-foreground">{s.label}</span>
              <kbd className="rounded border bg-muted px-2 py-0.5 font-mono text-xs">{s.keys}</kbd>
            </li>
          ))}
          <li className="flex items-center justify-between pt-2">
            <span className="text-muted-foreground">Toggle this help</span>
            <kbd className="rounded border bg-muted px-2 py-0.5 font-mono text-xs">?</kbd>
          </li>
        </ul>
      </div>
    </div>
  );
}
