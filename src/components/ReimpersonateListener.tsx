import { useEffect, useRef } from "react";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { startImpersonation } from "@/lib/platform.functions";
import { launchImpersonationTab } from "@/lib/impersonation-launch";
import { REIMPERSONATE_MESSAGE } from "@/components/ImpersonationBanner";

// BUG-2, console half: when an impersonation tab's session window closes, the
// tab shows an explicit ended state with a "Re-impersonate" button. That tab
// holds only the impersonated user's session and cannot mint a grant, so it
// asks the console that opened it. This listener is the console's side.
//
// Mounted inside the /platform layout, which already establishes that the
// viewer is a platform admin; the grant itself is authorized server-side by
// startImpersonation regardless.
export function ReimpersonateListener() {
  const impersonateFn = useServerFn(startImpersonation);
  // A closing tab can deliver its message more than once; one relaunch per
  // request is what the admin asked for.
  const inFlight = useRef(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Same-origin only: this hands back a session for a real customer.
      if (event.origin !== window.location.origin) return;
      const data = event.data as
        { type?: string; organizationId?: string; targetUserId?: string } | undefined;
      if (!data || data.type !== REIMPERSONATE_MESSAGE) return;
      if (!data.organizationId || !data.targetUserId) return;
      if (inFlight.current) return;

      inFlight.current = true;
      launchImpersonationTab(impersonateFn as never, {
        organizationId: data.organizationId,
        targetUserId: data.targetUserId,
      })
        .then((res) => toast.success(`Impersonating ${res.targetEmail} in a new tab`))
        .catch((e) => toast.error((e as Error).message))
        .finally(() => {
          inFlight.current = false;
        });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [impersonateFn]);

  return null;
}
