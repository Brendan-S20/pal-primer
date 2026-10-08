import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// Settings → Lead form is now part of Settings → Signup & quote form, because
// the two public forms it and Online signup configured are now one form (see
// lib/new-customer-form.ts). The address stays, forwarding, so a bookmark, the
// Knowledge Center's older wording and anybody's muscle memory still land on
// the page that holds these settings.
export const Route = createFileRoute("/_authenticated/settings/lead-form")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/online-signup", replace: true });
  },
  component: () => (
    <RedirectFallback to="/settings/online-signup" label="Signup & quote form settings" />
  ),
});
