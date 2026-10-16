import { createFileRoute } from "@tanstack/react-router";
import { RedirectFallback } from "@/components/RedirectFallback";

// AI panels live where the work happens (Reviews, Clients, Zones, Routes,
// Dashboard). Keep this path so old bookmarks / links land on the dashboard,
// which is where the owner-facing Marketing + Weekly digest panels render.
export const Route = createFileRoute("/_authenticated/ai-tools")({
  staticData: { clientRedirect: true },
  component: () => <RedirectFallback to="/dashboard" label="the dashboard" />,
});
