import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";
import { recoveryForwardPath } from "@/lib/password-recovery";

// The public marketing site lives at houndstack.com. This app (app.houndstack.com)
// sends unauthenticated visitors straight to sign-in; the router's _authenticated
// layout will then route them onward to their dashboard on success.
export const Route = createFileRoute("/")({
  beforeLoad: ({ location }) => {
    // The site root is where Supabase sends a password-reset link whose
    // redirect is not on its allow-list. A plain redirect to /auth drops the
    // `?code=` / `?token_hash=` it carries (a hash survives, and /auth
    // forwards that), so a recovery link goes straight to /reset-password
    // with everything it came with. Runs on the server too, where only the
    // query is visible.
    const forward = recoveryForwardPath(location.href);
    if (forward) throw redirect({ href: forward });
    throw redirect({ to: "/auth" });
  },
  // QA-P2: a pure-redirect route still needs a component. Without one the
  // router renders its default Outlet, which on a leaf route is a blank
  // page — and that is what /settings/payments produced on roughly one
  // cold load in four, with an unhandled error beside it.
  component: () => <RedirectFallback to="/auth" label="sign-in" />,
});
