import { createFileRoute, Link } from "@tanstack/react-router";
import { TextingNotLiveText, TextingStateBadge } from "@/components/TextingNotLive";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect, useRef } from "react";
import { listClientMessages, sendSmsToClient } from "@/lib/messages.functions";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { formatDateTime } from "@/lib/format";
import { pageTitle, titleHead, useDocumentTitle } from "@/lib/page-title";
import { useClientTexting } from "@/hooks/useClientTexting";

export const Route = createFileRoute("/_authenticated/messages/$clientId")({
  head: () => titleHead("Conversation", "Messages"),
  component: Thread,
});

function Thread() {
  const { clientId } = Route.useParams();
  const qc = useQueryClient();
  const listFn = useServerFn(listClientMessages);
  const sendFn = useServerFn(sendSmsToClient);
  const [body, setBody] = useState("");
  const endRef = useRef<HTMLDivElement>(null);
  const texting = useClientTexting();

  const { data, isLoading } = useQuery({
    queryKey: ["messages", clientId],
    queryFn: () => listFn({ data: { clientId } }),
    refetchInterval: 15_000,
  });

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages?.length]);
  useDocumentTitle(
    data?.client?.display_name ? pageTitle(data.client.display_name, "Messages") : null,
  );

  const send = useMutation({
    mutationFn: () => sendFn({ data: { clientId, body } }),
    onSuccess: () => {
      setBody("");
      toast.success("Sent");
      qc.invalidateQueries({ queryKey: ["messages", clientId] });
      qc.invalidateQueries({ queryKey: ["message-threads"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  const client = data?.client;
  const messages = data?.messages ?? [];
  const canSend = texting && !!client?.primary_phone && !client?.sms_opt_out;

  return (
    <div className="flex h-[70vh] flex-col rounded-lg border bg-card">
      <div className="flex items-center justify-between border-b px-4 py-3">
        <div className="flex min-w-0 items-center gap-1">
          {/* Mobile Phase 2: the conversation list is hidden below `md`, so
              give the thread a way back to it. */}
          <Link
            to="/messages"
            aria-label="Back to conversations"
            className="-ml-2 grid h-10 w-10 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-muted active:bg-muted md:hidden"
          >
            <ChevronLeft className="h-5 w-5 shrink-0" />
          </Link>
          <div className="min-w-0">
          <div className="text-sm font-semibold">
            {client?.display_name}
            {client?.sms_opt_out && (
              <span className="ml-2 rounded bg-destructive/15 px-1.5 text-3xs font-semibold uppercase text-destructive">
                opted out
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">{client?.primary_phone ?? "no phone"}</div>
          </div>
        </div>
        <Link to="/clients/$clientId" params={{ clientId }} className="shrink-0 text-xs text-primary underline">
          Open client
        </Link>
      </div>

      <div className="flex-1 space-y-2 overflow-y-auto p-4">
        {messages.length === 0 && (
          <p className="text-center text-sm text-muted-foreground">No messages yet.</p>
        )}
        {messages.map((m: any) => (
          <div
            key={m.id}
            className={`flex ${m.direction === "outbound" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[75%] rounded-lg px-3 py-2 text-sm ${
                m.direction === "outbound"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground"
              }`}
            >
              <div className="whitespace-pre-wrap">{m.body}</div>
              <div className="mt-1 text-3xs opacity-70">
                {formatDateTime(m.created_at)} · {m.status}
                {m.error ? ` · ${m.error}` : ""}
              </div>
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="border-t p-3">
        {!texting ? (
          <p className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <TextingStateBadge />
            <span className="min-w-0">
              <TextingNotLiveText />
            </span>
          </p>
        ) : !canSend && (
          <p className="mb-2 text-xs text-destructive">
            {client?.sms_opt_out
              ? "Client has opted out. Cannot send SMS."
              : "No phone number on file for this client."}
          </p>
        )}
        <div className="flex gap-2">
          <Textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder="Type a message…"
            disabled={!canSend || send.isPending}
          />
          <Button
            onClick={() => send.mutate()}
            disabled={!canSend || !body.trim() || send.isPending}
          >
            Send
          </Button>
        </div>
      </div>
    </div>
  );
}
