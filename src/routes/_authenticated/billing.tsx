import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// The CRM-subscription billing page moved into Settings (punch list #9).
// This stub keeps old bookmarks and Stripe billing-portal return URLs working.
export const Route = createFileRoute("/_authenticated/billing")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/billing", search: search as never });
  },
  // QA-P2: a pure-redirect route still needs a component. Without one the
  // router renders its default Outlet, which on a leaf route is a blank
  // page — and that is what /settings/payments produced on roughly one
  // cold load in four, with an unhandled error beside it.
  component: () => <RedirectFallback to="/settings/billing" label="Billing" />,
});
