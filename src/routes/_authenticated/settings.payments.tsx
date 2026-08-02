import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// Payments was promoted out of Settings to /payments (punch list #9). This
// stub keeps old bookmarks and in-flight Stripe onboarding return/refresh
// URLs working.
export const Route = createFileRoute("/_authenticated/settings/payments")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/payments", search: search as never });
  },
  // QA-P2: a pure-redirect route still needs a component. Without one the
  // router renders its default Outlet, which on a leaf route is a blank
  // page — and that is what /settings/payments produced on roughly one
  // cold load in four, with an unhandled error beside it.
  component: () => <RedirectFallback to="/payments" label="Payments" />,
});
