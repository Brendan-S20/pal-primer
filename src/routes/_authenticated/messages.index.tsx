import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/messages/")({
  component: () => (
    <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
      Select a conversation from the left, or start a new one with the + button above the list.
    </div>
  ),
});
