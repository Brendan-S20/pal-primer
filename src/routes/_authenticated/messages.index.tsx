import { createFileRoute } from "@tanstack/react-router";
import { useClientTexting } from "@/hooks/useClientTexting";

export const Route = createFileRoute("/_authenticated/messages/")({
  component: PickAConversation,
});

function PickAConversation() {
  const texting = useClientTexting();
  return (
    <div className="rounded-lg border bg-card p-8 text-center text-sm text-muted-foreground">
      {texting
        ? "Pick a conversation on the left, or press New message to text a client."
        : "Pick a conversation on the left. Texting your clients is coming soon."}
    </div>
  );
}
