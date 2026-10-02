import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/messages/")({
  component: () => (
    <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
      Pick a conversation on the left, or press New message to text a client.
    </div>
  ),
});
