import { createFileRoute, redirect } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// Punch list #11 follow-up: AI tools no longer have a dedicated destination —
// each panel lives where the work happens (Reviews, Clients, Zones, Routes,
// Dashboard). Keep this path so old bookmarks / links land on the dashboard,
// which is where the owner-facing Marketing + Weekly digest panels render.
export const Route = createFileRoute("/_authenticated/ai-tools")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
  // QA-P2: a pure-redirect route still needs a component. Without one the
  // router renders its default Outlet, which on a leaf route is a blank
  // page — and that is what /settings/payments produced on roughly one
  // cold load in four, with an unhandled error beside it.
  component: () => <RedirectFallback to="/dashboard" label="the dashboard" />,
});
