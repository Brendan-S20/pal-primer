import { useEffect, useState } from "react";
import { supabase, isImpersonationTab } from "@/integrations/supabase/client";
import { endImpersonationSession } from "@/lib/platform.functions";
import { ShieldAlert } from "lucide-react";

// Persistent, page-independent banner shown on EVERY page of an impersonation
// tab (QA finding #5 / H2), with a one-click exit that ends only this tab's
// sessionStorage-scoped session — never the admin's own — and closes the audit
// loop with a stop event + duration.
export function ImpersonationBanner() {
  const [info, setInfo] = useState<{
    email: string;
    orgName: string;
    grantId?: string;
    startedAt?: string;
  } | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (!isImpersonationTab()) return;
    try {
      const raw = window.sessionStorage.getItem("hs_impersonation");
      if (raw) setInfo(JSON.parse(raw));
    } catch { /* ignore */ }
  }, []);

  if (!info) return null;

  const exit = async () => {
    setExiting(true);
    // Record the stop event + duration BEFORE we sign out, while the grant id
    // is still to hand. Authorized by grant-id possession (server-side), so it
    // works even though this tab holds only the impersonated user's session.
    if (info.grantId) {
      try {
        await endImpersonationSession({ data: { grantId: info.grantId } });
      } catch { /* audit is best-effort — never block the exit */ }
    }
    try {
      await supabase.auth.signOut();
      window.sessionStorage.removeItem("hs_impersonation");
    } catch { /* best effort */ }
    // The tab was opened by the admin console; closing it returns them cleanly
    // to their own still-intact session. Fall back to a blank page if the
    // browser refuses to close a script-opened tab.
    window.close();
    window.location.replace("about:blank");
  };

  return (
    <div
      role="alert"
      className="sticky top-0 z-[100] flex flex-wrap items-center justify-center gap-x-3 gap-y-1 bg-amber-500 px-4 py-2 text-center text-sm font-medium text-amber-950"
    >
      <ShieldAlert className="h-4 w-4 shrink-0" />
      <span>
        Viewing as <strong>{info.email}</strong> ({info.orgName}), platform-admin impersonation
      </span>
      <button
        onClick={exit}
        disabled={exiting}
        className="rounded bg-amber-950 px-2 py-0.5 text-xs font-semibold text-amber-50 hover:bg-amber-900 disabled:opacity-60"
      >
        {exiting ? "Exiting…" : "Exit impersonation"}
      </button>
    </div>
  );
}
