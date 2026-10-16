import { createFileRoute } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// Payments was promoted out of Settings to /payments (punch list #9). This
// stub keeps old bookmarks and in-flight Stripe onboarding return/refresh
// URLs working.
export const Route = createFileRoute("/_authenticated/settings/payments")({
  staticData: { clientRedirect: true },
  component: () => <RedirectFallback to="/payments" label="Payments" />,
});
