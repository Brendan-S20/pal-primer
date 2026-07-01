import { createFileRoute, Link, Outlet } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listMessageThreads } from "@/lib/messages.functions";

export const Route = createFileRoute("/_authenticated/messages")({
  component: MessagesLayout,
});

function MessagesLayout() {
  const fn = useServerFn(listMessageThreads);
  const { data, isLoading } = useQuery({
    queryKey: ["message-threads"],
    queryFn: () => fn({}),
  });

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[280px_1fr]">
      <aside className="rounded-lg border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="text-sm font-semibold">Conversations</h2>
        </div>
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
                      <span className="rounded bg-destructive/15 px-1.5 text-[10px] font-semibold uppercase text-destructive">
                        opt-out
                      </span>
                    )}
                  </div>
                  <span className="line-clamp-1 text-xs text-muted-foreground">
                    {t.direction === "inbound" ? "↳ " : "→ "}
                    {t.body}
                  </span>
                  <span className="text-[10px] text-muted-foreground">
                    {new Date(t.created_at).toLocaleString()}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </aside>
      <section>
        <Outlet />
      </section>
    </div>
  );
}
