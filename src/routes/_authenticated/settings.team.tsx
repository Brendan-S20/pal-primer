import { createFileRoute } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// The team page is Settings → Users & roles at /settings/users. People type
// /settings/team (#1030), so it forwards there instead of showing not-found.
// The address is web-only: it sits in STAYS_IN_BROWSER, so no manifest or
// native claim changes.
export const Route = createFileRoute("/_authenticated/settings/team")({
  staticData: { clientRedirect: true },
  component: () => <RedirectFallback to="/settings/users" label="Users & roles" />,
});
