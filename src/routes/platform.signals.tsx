import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getFranchiseSignals, type FranchiseSignalRow } from "@/lib/platform-signals.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Building2, CreditCard, Link2, MapPin, Radar } from "lucide-react";
import { titleHead } from "@/lib/page-title";

export const Route = createFileRoute("/platform/signals")({
  head: () => titleHead("Franchise signals", "Platform admin"),
  component: SignalsPage,
});

// A lead's strength is the UNLINKED org count: orgs already under a parent
// have had the franchise conversation, so a fully-linked cluster is a win to
// glance at, not a lead — it sinks to the bottom. Among live leads, state
// footprint breaks ties before raw size, because crossing state lines is what
// separates "an operator with a structure" from someone with two accounts.
function bySignalStrength(a: FranchiseSignalRow, b: FranchiseSignalRow) {
  const ua = a.org_count - a.already_linked;
  const ub = b.org_count - b.already_linked;
  if ((ua === 0) !== (ub === 0)) return ua === 0 ? 1 : -1;
  if (ub !== ua) return ub - ua;
  if (b.state_count !== a.state_count) return b.state_count - a.state_count;
  return b.org_count - a.org_count;
}

// The one-line pitch a salesperson needs: what makes this cluster worth a
// call, in the strongest terms the data supports.
function whyInteresting(r: FranchiseSignalRow): string {
  const unlinked = r.org_count - r.already_linked;
  if (unlinked === 0) {
    return "Every org here already sits under a parent — this operator is converted. Nothing to chase.";
  }
  const parts: string[] = [];
  if (r.state_count > 1) {
    parts.push(
      `operating across ${r.state_count} states — usually separate legal entities, which is exactly what Enterprise consolidates`,
    );
  }
  if (r.stripe_accounts > 1) {
    parts.push(`paying for ${r.stripe_accounts} separate Stripe setups`);
  }
  if (r.already_linked > 0) {
    parts.push(
      `${r.already_linked} of ${r.org_count} already linked to a parent — the rest of the cluster is low-hanging fruit`,
    );
  }
  if (!parts.length) {
    return `${r.org_count} separate signups behind one company domain — likely one operator paying ${r.org_count}× instead of once.`;
  }
  return `${r.org_count} signups behind one company domain, ` + parts.join("; ") + ".";
}

function SignalCard({ r }: { r: FranchiseSignalRow }) {
  const unlinked = r.org_count - r.already_linked;
  const converted = unlinked === 0;

  return (
    <Card className={converted ? "opacity-60" : undefined}>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="font-mono text-base">@{r.email_domain}</CardTitle>
          <Badge variant="secondary">
            {r.org_count} org{r.org_count === 1 ? "" : "s"}
          </Badge>
          {r.state_count > 1 && (
            <Badge className="bg-emerald-600 text-white">{r.state_count} states</Badge>
          )}
          {converted ? (
            <Badge variant="outline">
              <Link2 className="mr-1 h-3 w-3 shrink-0" /> Fully linked
            </Badge>
          ) : r.already_linked > 0 ? (
            <Badge className="bg-blue-600 text-white">
              <Link2 className="mr-1 h-3 w-3 shrink-0" /> {r.already_linked} of {r.org_count} linked
            </Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{whyInteresting(r)}</p>
        {/* Each chip now links to its own tenant. It could not before: the RPC
            returned names and ids as two arrays that were not in the same
            order, so pairing them here would have pointed at the wrong tenant
            about as often as the right one. They arrive as one object each now.

            The ones NOT already linked are the calls left to make, so linked
            ones are dimmed rather than hidden — a cluster where two of five are
            done is a different pitch from one where none are. */}
        <div className="flex flex-wrap gap-1.5">
          {r.orgs.map((org) => (
            <Link
              key={org.id}
              to="/platform/tenants/$id"
              params={{ id: org.id }}
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs transition hover:border-primary hover:text-primary ${
                org.linked ? "bg-muted/20 text-muted-foreground" : "bg-muted/40"
              }`}
              title={org.linked ? "Already linked to a franchise" : "Not linked yet"}
            >
              {org.linked ? (
                <Link2 className="h-3 w-3 shrink-0" />
              ) : (
                <Building2 className="h-3 w-3 shrink-0 text-muted-foreground" />
              )}
              {org.name}
            </Link>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3 w-3 shrink-0" />
            {r.states ? r.states : "No property locations on file"}
          </span>
          <span className="inline-flex items-center gap-1">
            <CreditCard className="h-3 w-3 shrink-0" />
            {r.stripe_accounts} Stripe account{r.stripe_accounts === 1 ? "" : "s"}
          </span>
          <Link to="/platform/tenants" className="font-medium text-primary hover:underline">
            All tenants →
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function SignalsPage() {
  const fn = useServerFn(getFranchiseSignals);
  const q = useQuery({ queryKey: ["platform", "signals"], queryFn: () => fn() });

  const rows = [...(q.data?.rows ?? [])].sort(bySignalStrength);
  const leads = rows.filter((r) => r.org_count - r.already_linked > 0).length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Franchise signals</h1>
        <p className="text-sm text-muted-foreground">
          Clusters of separate signups sharing a custom email domain — the tell-tale that one
          multi-location operator is paying per location instead of talking to us about Enterprise.
          Public providers like Gmail are excluded: they're the base rate, not a signal.
        </p>
      </div>

      {q.isLoading ? (
        <div className="space-y-3">
          <Skeleton className="h-32 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : q.error ? (
        <div className="text-sm text-destructive">{(q.error as Error).message}</div>
      ) : !rows.length ? (
        <EmptyState
          icon={<Radar className="h-5 w-5 shrink-0" />}
          title="No clusters yet"
          description="When two or more organizations sign up with owner emails on the same custom domain, they show up here as a franchise lead."
        />
      ) : (
        <>
          <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {leads} live lead{leads === 1 ? "" : "s"} · {rows.length - leads} already converted
          </div>
          <div className="space-y-3">
            {rows.map((r) => (
              <SignalCard key={r.email_domain} r={r} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
