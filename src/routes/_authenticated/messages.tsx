import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listMessageThreads } from "@/lib/messages.functions";
import { listClients } from "@/lib/clients.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MessageSquarePlus } from "lucide-react";

export const Route = createFileRoute("/_authenticated/messages")({
  component: MessagesLayout,
});

// Start-a-conversation picker (punch list #7): the Messages page previously
// had no compose affordance — an owner had to know to go find the client's
// detail page first.
function NewMessagePicker({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const clientsFn = useServerFn(listClients);
  const [q, setQ] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => clientsFn(),
  });
  const needle = q.trim().toLowerCase();
  const matches = (((data as any)?.clients as any[]) ?? [])
    .filter((c: any) =>
      !needle ||
      c.display_name?.toLowerCase().includes(needle) ||
      c.primary_phone?.toLowerCase().includes(needle) ||
      c.primary_email?.toLowerCase().includes(needle),
    )
    .slice(0, 8);

  return (
    <div className="border-b p-3">
      <Input
        autoFocus
        placeholder="Search clients…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className="mt-2 max-h-56 overflow-y-auto">
        {isLoading && <p className="p-2 text-xs text-muted-foreground">Loading clients…</p>}
        {!isLoading && matches.length === 0 && (
          <p className="p-2 text-xs text-muted-foreground">No matching clients.</p>
        )}
        <ul>
          {matches.map((c: any) => (
            <li key={c.id}>
              <button
                type="button"
                className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                onClick={() => {
                  onClose();
                  navigate({ to: "/messages/$clientId", params: { clientId: c.id } });
                }}
              >
                <span className="font-medium">{c.display_name}</span>
                <span className="ml-2 text-xs text-muted-foreground">
                  {c.primary_phone ?? "no phone"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function MessagesLayout() {
  const fn = useServerFn(listMessageThreads);
  const [composing, setComposing] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ["message-threads"],
    queryFn: () => fn({}),
  });

  // Mobile Phase 2: below `md` this is a master→detail flow, not a stacked
  // two-pane. On /messages the conversation list IS the screen (the desktop
  // "select a conversation" placeholder is hidden); on a thread the list is
  // hidden and the thread header carries a back link. Desktop keeps both panes.
  const pathname = useRouterState({ select: (r) => r.location.pathname });
  const onThread = pathname !== "/messages" && pathname !== "/messages/";

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
      <aside className={`rounded-lg border bg-card ${onThread ? "max-md:hidden" : ""}`}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Conversations</h2>
          <Button
            variant="ghost"
            size="icon"
            title="New message"
            onClick={() => setComposing((v) => !v)}
          >
            <MessageSquarePlus className="h-4 w-4" />
          </Button>
        </div>
        {composing && <NewMessagePicker onClose={() => setComposing(false)} />}
        <div className="max-h-[70vh] overflow-y-auto">
          {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && (data?.threads?.length ?? 0) === 0 && (
            <p className="p-4 text-sm text-muted-foreground">No messages yet.</p>
          )}
          <ul className="divide-y">
            {(data?.threads ?? []).map((t: any) => (
              <li key={t.id}>
                <Link
                  to="/messages/$clientId"
                  params={{ clientId: t.client_id }}
                  className="flex flex-col gap-1 px-4 py-3 text-sm hover:bg-muted/50"
                  activeProps={{ className: "bg-muted flex flex-col gap-1 px-4 py-3 text-sm" }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium">
                      {t.clients?.display_name ?? "Unknown client"}
                    </span>
                    {t.clients?.sms_opt_out && (
                      <span className="rounded bg-destructive/15 px-1.5 text-3xs font-semibold uppercase text-destructive">
                        opt-out
                      </span>
                    )}
                  </div>
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {t.direction === "inbound" ? "↳ " : "→ "}
                    {t.body}
                  </span>
                  <span className="text-3xs text-muted-foreground">
                    {new Date(t.created_at).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section className={onThread ? "" : "max-md:hidden"}>
        <Outlet />
      </section>
    </div>
  );
}
