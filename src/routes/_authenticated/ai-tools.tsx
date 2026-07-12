import { createFileRoute, redirect } from "@tanstack/react-router";

// Punch list #11 follow-up: AI tools no longer have a dedicated destination —
// each panel lives where the work happens (Reviews, Clients, Zones, Routes,
// Dashboard). Keep this path so old bookmarks / links land on the dashboard,
// which is where the owner-facing Marketing + Weekly digest panels render.
export const Route = createFileRoute("/_authenticated/ai-tools")({
  beforeLoad: () => {
    throw redirect({ to: "/dashboard" });
  },
});
