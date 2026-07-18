import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { supabase, isImpersonationTab } from "@/integrations/supabase/client";
import { consumeImpersonation } from "@/lib/platform.functions";
import { Loader2, ShieldAlert } from "lucide-react";

// Landing page for the NEW tab a platform admin opens to impersonate a tenant
// user (QA finding #5). This route lives OUTSIDE both the /_authenticated and
// /platform guards on purpose: the tab has no session yet, and — because its
// window.name is stamped with the impersonation prefix — its Supabase client
// persists to sessionStorage, so nothing it does can touch the admin's own
// localStorage session in any other tab.
export const Route = createFileRoute("/impersonate")({
  ssr: false,
  head: () => ({
    meta: [
      { title: "Starting impersonation…" },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: ImpersonateConsume,
});

function ImpersonateConsume() {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;

    (async () => {
      if (!isImpersonationTab()) {
        setError(
          "This page can only be opened from the platform admin console's Impersonate action.",
        );
        return;
      }
      // The one-time grant token travels in the URL fragment (never sent to a
      // server in a Referer header); we hand it to the exchange endpoint.
      const hash = window.location.hash.replace(/^#/, "");
      const token = new URLSearchParams(hash).get("t");
      if (!token) {
        setError("Missing impersonation token. Start again from the tenant page.");
        return;
      }
      // Clear the token from the address bar immediately.
      history.replaceState(null, "", window.location.pathname);

      try {
        const res = await consumeImpersonation({ data: { token } });
        const { error: sessErr } = await supabase.auth.setSession({
          access_token: res.accessToken,
          refresh_token: res.refreshToken,
        });
        if (sessErr) throw new Error(sessErr.message);
        // Remember who we're viewing as, for the persistent banner, plus the
        // grant id + start time so "Exit impersonation" can log a stop event
        // with the session duration (H2).
        try {
          window.sessionStorage.setItem(
            "hs_impersonation",
            JSON.stringify({
              email: res.targetEmail,
              orgName: res.orgName,
              grantId: res.grantId,
              startedAt: res.startedAt,
            }),
          );
        } catch { /* non-fatal */ }
        navigate({ to: "/dashboard" });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not start impersonation.");
      }
    })();
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-sm rounded-lg border bg-card p-6 text-center">
        {error ? (
          <>
            <ShieldAlert className="mx-auto h-8 w-8 text-destructive" />
            <h1 className="mt-3 text-lg font-semibold">Impersonation failed</h1>
            <p className="mt-2 text-sm text-muted-foreground">{error}</p>
            <button
              className="mt-4 text-sm text-primary underline underline-offset-2"
              onClick={() => window.close()}
            >
              Close this tab
            </button>
          </>
        ) : (
          <>
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="mt-3 text-sm text-muted-foreground">Starting impersonation session…</p>
          </>
        )}
      </div>
    </div>
  );
}
