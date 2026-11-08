import { createFileRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { listMessageThreads } from "@/lib/messages.functions";
import { ClientSearchPicker } from "@/components/ClientSearchPicker";
import { Button } from "@/components/ui/button";
import { MessageSquarePlus } from "lucide-react";
import { formatDateTime } from "@/lib/format";
import { titleHead } from "@/lib/page-title";
import { useClientTexting } from "@/hooks/useClientTexting";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";

export const Route = createFileRoute("/_authenticated/messages")({
  head: () => titleHead("Messages"),
  component: MessagesLayout,
});

// Start-a-conversation picker (punch list #7): the Messages page previously
// had no compose affordance — an owner had to know to go find the client's
// detail page first.
//
// It searches on the server (gaps-r2-01): it used to load the whole roster
// to filter eight names out of it, and matched only the exact characters of
// a name, phone or email.
function NewMessagePicker({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  return (
    <div className="border-b p-3">
      <ClientSearchPicker
        id="new-message-client"
        value={null}
        activeOnly={false}
        onChange={(c) => {
          if (!c) return;
          onClose();
          navigate({ to: "/messages/$clientId", params: { clientId: c.id } });
        }}
      />
    </div>
  );
}

function MessagesLayout() {
  const fn = useServerFn(listMessageThreads);
  const [composing, setComposing] = useState(false);
  // No business can text its clients until its own number clears carrier
  // registration. Until then this page is the history it has and a state
  // that says so, not a New message button that ends in an error.
  const texting = useClientTexting();
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
      {/* The one top-level page with no heading. Every other screen in the
          sidebar opens on an h1 naming it; this one opened on a card titled
          "Conversations", so the page and the nav item did not agree on what
          the place was called (launch pass, 2026-10). Hidden on a phone
          inside a thread, where the thread's own header with its back link
          is the heading and a second one would push the messages down. */}
      <div className={`md:col-span-2 ${onThread ? "max-md:hidden" : ""}`}>
        <h1 className="flex flex-wrap items-center gap-2 text-2xl font-semibold">
          Messages
          {!texting && <ComingSoonBadge />}
        </h1>
        <p className="text-sm text-muted-foreground">
          {texting
            ? "Text conversations between your business and your clients."
            : "Texting your clients is coming soon. Until then, visit reminders, on-my-way notices, review requests and billing reminders go by email."}
        </p>
      </div>
      <aside className={`rounded-lg border bg-card ${onThread ? "max-md:hidden" : ""}`}>
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Conversations</h2>
          {/* Labelled. It was a 36px icon with only a `title`, which is a
              tooltip, so on a phone the way to start a conversation was an
              unnamed glyph, and the empty state told people to press a
              "+ button" that is drawn as a speech bubble. */}
          {texting && (
            <Button
              variant="outline"
              size="sm"
              className="touch:min-h-11"
              aria-expanded={composing}
              disabled={!texting}
              title={texting ? undefined : "Texting your clients is coming soon"}
              onClick={() => setComposing((v) => !v)}
            >
              <MessageSquarePlus className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
              New message
            </Button>
          )}
        </div>
        {composing && texting && <NewMessagePicker onClose={() => setComposing(false)} />}
        <div className="max-h-[70vh] overflow-y-auto">
          {isLoading && <p className="p-4 text-sm text-muted-foreground">Loading…</p>}
          {!isLoading && (data?.threads?.length ?? 0) === 0 && (
            <p className="p-4 text-sm text-muted-foreground">
              {texting
                ? "No conversations yet. Press New message to text a client; their replies show up here."
                : "No conversations yet. Once texting your clients arrives, conversations show up here."}
            </p>
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
                    {formatDateTime(t.created_at)}
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
