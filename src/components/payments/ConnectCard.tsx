import { useEffect, useReducer, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import {
  CONNECT_PANEL_TIMEOUT_MS,
  INITIAL_CONNECT_CARD,
  connectCardReducer,
} from "@/lib/payments-load";

/** What Stripe hands onLoadError. Narrowed to the one field read here. */
type ConnectLoadError = { error?: { message?: string } };

export type ConnectHandlers = {
  onLoaderStart: () => void;
  onLoadError: (e: ConnectLoadError) => void;
};

// Each embedded Stripe Connect component can silently fail to load (four empty
// boxes, B5/I10). Wrap every one in loading/error/retry chrome. The Connect
// components emit onLoaderStart when they begin rendering and onLoadError when
// they fail; we drive the card state off those and remount on retry.
//
// And a deadline, because neither event is guaranteed (#436). When connect-js
// itself never loads (a CORS failure from connect-js.stripe.com, a content
// blocker, no network), Stripe has nothing to emit either event FROM, and the
// card read "Loading payouts…" for as long as the tab was open. After
// CONNECT_PANEL_TIMEOUT_MS without onLoaderStart, it says it could not load,
// with Retry, like any other failure.
export function ConnectCard({
  title,
  hint,
  timeoutMs = CONNECT_PANEL_TIMEOUT_MS,
  children,
}: {
  title: string;
  /** One line saying what this panel is for. The embedded components open on a
   *  table with no heading of their own, so without this the tab is three
   *  unlabelled grids. */
  hint?: string;
  timeoutMs?: number;
  children: (handlers: ConnectHandlers) => ReactNode;
}) {
  const [card, dispatch] = useReducer(connectCardReducer, INITIAL_CONNECT_CARD);
  const { state, message, attempt } = card;

  // Restarted on every attempt; cleared the moment the panel is ready or has
  // failed, and the reducer ignores a deadline that lands after either, so a
  // slow-but-successful load is never overwritten.
  useEffect(() => {
    if (state !== "loading") return;
    const t = setTimeout(() => dispatch({ type: "deadline" }), timeoutMs);
    return () => clearTimeout(t);
  }, [state, attempt, timeoutMs]);

  const handlers: ConnectHandlers = {
    onLoaderStart: () => dispatch({ type: "loaderStart" }),
    onLoadError: (e: ConnectLoadError) =>
      dispatch({ type: "loadError", message: e?.error?.message ?? null }),
  };
  return (
    <div className="min-w-0 rounded-lg border bg-card p-4">
      <div className="mb-2">
        <div className="text-sm font-medium">{title}</div>
        {hint && <div className="text-2xs text-muted-foreground">{hint}</div>}
      </div>
      {state === "error" ? (
        <div role="alert" className="space-y-2 text-sm">
          <p className="text-destructive">
            Couldn't load {title.toLowerCase()}.{message ? ` ${message}` : ""}
          </p>
          <Button variant="outline" size="sm" onClick={() => dispatch({ type: "retry" })}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          {state === "loading" && (
            <p className="text-sm text-muted-foreground">Loading {title.toLowerCase()}…</p>
          )}
          {/* Stripe sizes its iframe to this box. If a panel is ever wider than
              the content column (a wide table at 1024px), it scrolls here
              rather than widening the page. */}
          <div
            key={attempt}
            className={state === "loading" ? "hidden" : "max-w-full overflow-x-auto"}
          >
            {children(handlers)}
          </div>
        </>
      )}
    </div>
  );
}
