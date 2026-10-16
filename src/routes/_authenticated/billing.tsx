import { createFileRoute } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// The CRM-subscription billing page moved into Settings (punch list #9).
// This stub keeps old bookmarks and Stripe billing-portal return URLs working.
export const Route = createFileRoute("/_authenticated/billing")({
  staticData: { clientRedirect: true },
  component: () => <RedirectFallback to="/settings/billing" label="Billing" />,
});
