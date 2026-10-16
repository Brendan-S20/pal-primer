import { useEffect } from "react";
import { useNavigate, useRouterState } from "@tanstack/react-router";

declare module "@tanstack/react-router" {
  interface StaticDataRouteOption {
    clientRedirect?: boolean;
  }
}

// Client-only aliases navigate after commit. A beforeLoad redirect during
// hydration can expose a redirected match whose suspension promise is gone.
// Server-rendered public redirects also use this as a visible fallback.
export function RedirectFallback({
  to,
  label,
}: {
  /** Where this route is an alias for. */
  to: string;
  /** What the destination is called, in the sentence shown to the person. */
  label: string;
}) {
  const navigate = useNavigate();
  const ready = useRouterState({ select: (state) => state.status === "idle" && !state.isLoading });

  useEffect(() => {
    if (!ready) return;
    // `replace` so the alias does not become a back-button trap between the
    // two URLs.
    void navigate({ to, replace: true, search: (s: Record<string, unknown>) => s });
  }, [navigate, to, ready]);

  return (
    <div className="flex min-h-[40vh] items-center justify-center p-8">
      <p className="text-sm text-muted-foreground">
        Taking you to {label}…{" "}
        <a href={to} className="inline-flex min-h-11 items-center underline underline-offset-4">
          Continue
        </a>
      </p>
    </div>
  );
}
