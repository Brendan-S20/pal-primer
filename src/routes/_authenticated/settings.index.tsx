import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

export const Route = createFileRoute("/_authenticated/settings/")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/preferences" });
  },
  // QA-P2: a pure-redirect route still needs a component. Without one the
  // router renders its default Outlet, which on a leaf route is a blank
  // page — and that is what /settings/payments produced on roughly one
  // cold load in four, with an unhandled error beside it.
  component: () => <RedirectFallback to="/settings/preferences" label="Settings" />,
});
