import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// The public marketing site lives at houndstack.com. This app (app.houndstack.com)
// sends unauthenticated visitors straight to sign-in; the router's _authenticated
// layout will then route them onward to their dashboard on success.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/auth" });
  },
  // QA-P2: a pure-redirect route still needs a component. Without one the
  // router renders its default Outlet, which on a leaf route is a blank
  // page — and that is what /settings/payments produced on roughly one
  // cold load in four, with an unhandled error beside it.
  component: () => <RedirectFallback to="/auth" label="sign-in" />,
});
