// Persistent client header (spec): identity, status, contact, and the
// numbers that matter, with Message / Edit Client / More Actions. Everything
// below it lives in tabs; everything here is read-only.
import { Link } from "@tanstack/react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { MoreHorizontal, Pencil } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { updateClient } from "@/lib/clients.functions";

export function ClientHeader({
  client,
  clientId,
  propertyCount,
  activeServiceCount,
  outstandingCents,
  canBill,
  onEditClient,
}: {
  client: any;
  clientId: string;
  propertyCount: number;
  activeServiceCount: number;
  /** null = caller can't see billing; hide the stat rather than show 0. */
  outstandingCents: number | null;
  canBill: boolean;
  onEditClient: () => void;
}) {
  const qc = useQueryClient();
  const updateFn = useServerFn(updateClient);
  const statusMut = useMutation({
    mutationFn: (active: boolean) => updateFn({ data: { clientId, active } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["client", clientId] });
      toast.success("Client updated");
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const initials = (client.display_name ?? "?")
    .split(/\s+/)
    .map((w: string) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <header className="rounded-xl border bg-card px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-semibold text-primary">
            {initials}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-xl font-semibold">{client.display_name}</h1>
              <Badge variant={client.active === false ? "outline" : "secondary"}>
                {client.active === false ? "Inactive" : "Active"}
              </Badge>
              <Badge variant={client.account_type === "commercial" ? "default" : "secondary"}>
                {client.account_type === "commercial" ? "Commercial" : "Residential"}
              </Badge>
              {(client.churn_score ?? 0) >= 60 && <Badge variant="destructive">At risk</Badge>}
              {(client.tags ?? []).map((t: string) => (
                <Badge key={t} variant="outline">
                  {t}
                </Badge>
              ))}
            </div>
            <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm text-muted-foreground">
              {client.primary_phone ? (
                <a href={`tel:${client.primary_phone}`} className="hover:text-foreground hover:underline">
                  {client.primary_phone}
                </a>
              ) : (
                <span>No phone</span>
              )}
              {client.primary_email ? (
                <a
                  href={`mailto:${client.primary_email}`}
                  className="hover:text-foreground hover:underline"
                >
                  {client.primary_email}
                </a>
              ) : (
                <span>No email</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Link to="/messages/$clientId" params={{ clientId }}>
            <Button variant="outline" size="sm">
              Message
            </Button>
          </Link>
          <Button size="sm" onClick={onEditClient}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" /> Edit Client
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" aria-label="More actions">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>More actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {client.active === false ? (
                <DropdownMenuItem onClick={() => statusMut.mutate(true)}>
                  Reactivate client
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onClick={() => statusMut.mutate(false)}>
                  Mark client inactive
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <dl className="mt-4 grid grid-cols-2 gap-3 border-t pt-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Properties</dt>
          <dd className="text-lg font-semibold">{propertyCount}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Active services</dt>
          <dd className="text-lg font-semibold">{activeServiceCount}</dd>
        </div>
        {canBill && (
          <div>
            <dt className="text-xs uppercase tracking-wide text-muted-foreground">Outstanding</dt>
            <dd
              className={`text-lg font-semibold ${(outstandingCents ?? 0) > 0 ? "text-destructive" : ""}`}
            >
              ${(((outstandingCents ?? 0) as number) / 100).toFixed(2)}
            </dd>
          </div>
        )}
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Client since</dt>
          <dd className="text-lg font-semibold">
            {client.created_at ? new Date(client.created_at).toLocaleDateString() : "-"}
          </dd>
        </div>
      </dl>
    </header>
  );
}
