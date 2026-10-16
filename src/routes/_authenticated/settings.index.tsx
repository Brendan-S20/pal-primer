import { createFileRoute } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

export const Route = createFileRoute("/_authenticated/settings/")({
  staticData: { clientRedirect: true },
  component: () => <RedirectFallback to="/settings/preferences" label="Settings" />,
});
