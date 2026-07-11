import { createFileRoute, redirect } from "@tanstack/react-router";

// Payments was promoted out of Settings to /payments (punch list #9). This
// stub keeps old bookmarks and in-flight Stripe onboarding return/refresh
// URLs working.
export const Route = createFileRoute("/_authenticated/settings/payments")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/payments", search: search as never });
  },
});
