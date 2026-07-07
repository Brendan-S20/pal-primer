import { createFileRoute, redirect } from "@tanstack/react-router";

// The public marketing site lives at houndstack.com. This app (app.houndstack.com)
// sends unauthenticated visitors straight to sign-in; the router's _authenticated
// layout will then route them onward to their dashboard on success.
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/auth" });
  },
});
