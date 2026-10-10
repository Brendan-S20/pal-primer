import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { supabase } from "@/integrations/supabase/client";
import { PublicShell } from "@/components/PublicShell";
import { AccessOffCard, type AccessOffState } from "@/components/AccessOffCard";
import { getMyOrg } from "@/lib/org.functions";
import { clearPersistedReadCaches, signOutAndClearDevice } from "@/lib/offline/read-cache";
import { pageTitle } from "@/lib/page-title";

// Where the shell sends somebody whose access the owner has turned off
// (Settings → Users, staff.active = false; 20261009180000).
//
// The database already refuses them everything, so without this screen they
// got a workspace in which every list was empty and every save failed. Here
// they get one sentence that says what happened and who can undo it, a way to
// check again once the owner has, and Sign out.
//
// A technician reads this on their phone, so it speaks the phone's language
// (tests/support/tech-screens.ts). The business name is the office's own text:
// it goes in as <business/>'s child, in a <bdi>, never by interpolation.
export const Route = createFileRoute("/access-off")({
  ssr: false,
  // No hydration timer for a client-only route; see _authenticated/route.tsx.
  pendingMinMs: 0,
  head: () => ({
    meta: [{ title: pageTitle("Access turned off") }, { name: "robots", content: "noindex" }],
  }),
  component: AccessOffPage,
});

function AccessOffPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AccessOffState>({ kind: "checking" });

  const check = async (again: boolean) => {
    setState({ kind: "checking" });
    try {
      const { data } = await supabase.auth.getSession();
      if (!data.session) {
        window.location.href = "/auth";
        return;
      }
      // Fresh, never the cached copy: the cache is what said "off" a moment
      // ago, and the point of asking again is that the owner may have changed it.
      const org = await getMyOrg();
      if (org.accessTurnedOff) {
        // The server has said so, so the device copy of the route (addresses,
        // gate codes) goes. Queued field work is left alone: it cannot sync
        // while they are off, and it is theirs to keep if they come back on.
        clearPersistedReadCaches();
        queryClient.setQueryData(["my-org"], org);
        setState({ kind: "off", business: org.accessTurnedOff.organizationName || null, checkedAgain: again });
        return;
      }
      // Back on, or never off: let the shell decide where they belong.
      queryClient.removeQueries({ queryKey: ["my-org"] });
      navigate({ to: "/dashboard", replace: true });
    } catch {
      setState({ kind: "error" });
    }
  };

  useEffect(() => {
    void check(false);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signOut = async () => {
    await signOutAndClearDevice();
    window.location.href = "/auth";
  };

  return (
    <PublicShell tagline={t("accessOff.pageTitle")}>
      <AccessOffCard
        state={state}
        onCheckAgain={() => void check(true)}
        onSignOut={() => void signOut()}
      />
    </PublicShell>
  );
}
