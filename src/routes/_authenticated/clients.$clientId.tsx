import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getClient } from "@/lib/clients.functions";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/clients/$clientId")({
  component: ClientDetail,
});

function ClientDetail() {
  const { clientId } = Route.useParams();
  const fn = useServerFn(getClient);
  const { data, isLoading, error } = useQuery({
    queryKey: ["client", clientId],
    queryFn: () => fn({ data: { clientId } }),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (error) return <p className="text-destructive">{(error as Error).message}</p>;
  const client = data!.client;

  return (
    <div className="space-y-6">
      <div>
        <Link to="/clients" className="text-sm text-muted-foreground hover:underline">
          ← Clients
        </Link>
        <div className="mt-2 flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{client.display_name}</h1>
          <Badge variant={client.account_type === "commercial" ? "default" : "secondary"}>
            {client.account_type}
          </Badge>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-lg border bg-card p-5">
          <h2 className="text-sm font-medium">Contact</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Email</dt>
              <dd>{client.primary_email ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Phone</dt>
              <dd>{client.primary_phone ?? "—"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Status</dt>
              <dd>{client.active ? "Active" : "Inactive"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border border-dashed bg-card p-5">
          <h2 className="text-sm font-medium">Properties, dogs, subscriptions</h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Coming in the next session — the schema is in place, the UI lands with the visit-generation engine.
          </p>
        </div>
      </div>
    </div>
  );
}
