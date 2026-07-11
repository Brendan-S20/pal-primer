import { createFileRoute, redirect } from "@tanstack/react-router";

// The CRM-subscription billing page moved into Settings (punch list #9).
// This stub keeps old bookmarks and Stripe billing-portal return URLs working.
export const Route = createFileRoute("/_authenticated/billing")({
  beforeLoad: ({ search }) => {
    throw redirect({ to: "/settings/billing", search: search as never });
  },
});
