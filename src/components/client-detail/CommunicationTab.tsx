// Communication tab (QA round 8): messaging only — the full thread and
// composer. Portal status, review requests, and referrals live on the
// Reviews & referrals tab.
import { MessageComposer } from "@/components/client-detail/comms-panels";
import { TextingConsentPanel } from "@/components/client-detail/TextingConsentPanel";
import { formatPhone } from "@/lib/format";
import { useClientTexting } from "@/hooks/useClientTexting";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";

export function CommunicationTab({ client }: { client: any }) {
  const texting = useClientTexting();
  return (
    <div className="space-y-6">
      <TextingConsentPanel client={client} />

      {/* Message thread + composer */}
      <section className="rounded-lg border bg-card shadow-sm p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex flex-wrap items-center gap-2 text-sm font-medium">
            Messages
            {!texting && <ComingSoonBadge />}
          </h2>
          {!texting ? null : client.primary_phone ? (
            <span className="text-xs text-muted-foreground">
              Sending to {formatPhone(client.primary_phone)}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No phone number on file</span>
          )}
        </div>
        <div className="mt-2">
          <MessageComposer client={client} bare />
        </div>
      </section>
    </div>
  );
}
