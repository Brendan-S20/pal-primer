import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout route for the client portal. Currently renders the child route
// unchanged (portal.$token.index.tsx holds the full single-page portal).
// Section-by-section extraction into sibling routes (visits, billing,
// property, requests, account) happens in follow-up turns.
export const Route = createFileRoute("/portal/$token")({
  head: () => ({
    meta: [
      { title: "Your service portal" },
      { name: "description", content: "View upcoming visits, invoices, and account details." },
    ],
  }),
  component: () => <Outlet />,
});
