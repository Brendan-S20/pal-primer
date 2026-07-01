import { createFileRoute, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

const searchSchema = z.object({ token: z.string().optional() });

export const Route = createFileRoute("/unsubscribe")({
  validateSearch: (s) => searchSchema.parse(s),
  head: () => ({ meta: [{ title: "Unsubscribe · Scoop CRM" }] }),
  component: UnsubscribePage,
});

type State =
  | { kind: "loading" }
  | { kind: "invalid" }
  | { kind: "already" }
  | { kind: "ready" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function UnsubscribePage() {
  const { token } = useSearch({ from: "/unsubscribe" });
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    if (!token) return setState({ kind: "invalid" });
    (async () => {
      try {
        const r = await fetch(`/email/unsubscribe?token=${encodeURIComponent(token)}`);
        const body = await r.json();
        if (!r.ok) return setState({ kind: "invalid" });
        if (body.valid === false && body.reason === "already_unsubscribed") {
          return setState({ kind: "already" });
        }
        if (body.valid === true) return setState({ kind: "ready" });
        setState({ kind: "invalid" });
      } catch (e) {
        setState({ kind: "error", message: (e as Error).message });
      }
    })();
  }, [token]);

  const confirm = async () => {
    if (!token) return;
    setState({ kind: "loading" });
    try {
      const r = await fetch("/email/unsubscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const body = await r.json();
      if (body.success) setState({ kind: "success" });
      else if (body.reason === "already_unsubscribed") setState({ kind: "already" });
      else setState({ kind: "error", message: body.error || "Failed" });
    } catch (e) {
      setState({ kind: "error", message: (e as Error).message });
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="max-w-md w-full text-center border rounded-xl p-8 bg-card">
        <h1 className="text-2xl font-semibold">Email preferences</h1>
        {state.kind === "loading" && <p className="mt-4 text-muted-foreground">Loading…</p>}
        {state.kind === "invalid" && (
          <p className="mt-4 text-muted-foreground">This unsubscribe link is invalid or has expired.</p>
        )}
        {state.kind === "already" && (
          <p className="mt-4 text-muted-foreground">You're already unsubscribed. Nothing else to do.</p>
        )}
        {state.kind === "ready" && (
          <>
            <p className="mt-4 text-muted-foreground">
              Confirm you want to stop receiving emails at this address.
            </p>
            <button
              onClick={confirm}
              className="mt-6 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            >
              Unsubscribe
            </button>
          </>
        )}
        {state.kind === "success" && (
          <p className="mt-4 text-muted-foreground">You've been unsubscribed. Sorry to see you go.</p>
        )}
        {state.kind === "error" && (
          <p className="mt-4 text-destructive">{state.message}</p>
        )}
      </div>
    </div>
  );
}
