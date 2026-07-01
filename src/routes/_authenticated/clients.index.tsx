import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listClients } from "@/lib/clients.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const Route = createFileRoute("/_authenticated/clients/")({
  component: ClientsList,
});

function ClientsList() {
  const fn = useServerFn(listClients);
  const { data, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => fn(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Clients</h1>
        <Link to="/clients/new">
          <Button>New client</Button>
        </Link>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !data?.clients.length ? (
        <div className="rounded-lg border border-dashed bg-card p-10 text-center">
          <p className="text-muted-foreground">No clients yet.</p>
          <Link to="/clients/new" className="mt-3 inline-block">
            <Button size="sm">Create the first one</Button>
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border bg-card">
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Name</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Email</th>
                <th className="px-4 py-2 font-medium">Phone</th>
                <th className="px-4 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.id} className="border-t hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <Link
                      to="/clients/$clientId"
                      params={{ clientId: c.id }}
                      className="font-medium hover:underline"
                    >
                      {c.display_name}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant={c.account_type === "commercial" ? "default" : "secondary"}>
                      {c.account_type}
                    </Badge>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">{c.primary_email ?? "—"}</td>
                  <td className="px-4 py-3 text-muted-foreground">{c.primary_phone ?? "—"}</td>
                  <td className="px-4 py-3">
                    {c.active ? (
                      <span className="text-emerald-600">Active</span>
                    ) : (
                      <span className="text-muted-foreground">Inactive</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
