import { createFileRoute } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// Zones & pricing lives inside Settings at /settings/zones (#864). This
// address stays, forwarding, so the sidebar's "Zones", the command palette,
// bookmarks, help articles and the setup steps that still say /zones all land
// on the page with the Settings menu beside it. Search params ride along
// (RedirectFallback keeps them), and `replace` keeps Back from bouncing.
export const Route = createFileRoute("/_authenticated/zones")({
  staticData: { clientRedirect: true },
  component: () => <RedirectFallback to="/settings/zones" label="Zones & pricing" />,
});
