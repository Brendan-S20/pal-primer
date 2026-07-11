import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useMemo, useState } from "react";
import { listClients } from "@/lib/clients.functions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card } from "@/components/ui/card";
import { AlertTriangle, Search, Users } from "lucide-react";

export const Route = createFileRoute("/_authenticated/clients/")({
  component: ClientsList,
});

type StatusFilter = "all" | "active" | "inactive" | "outstanding" | "at_risk";
type TypeFilter = "all" | "residential" | "commercial";

function money(cents: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(cents / 100);
}

function ClientsList() {
  const fn = useServerFn(listClients);
  const { data, isLoading } = useQuery({
    queryKey: ["clients"],
    queryFn: () => fn(),
  });

  const [q, setQ] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");

  const clients = data?.clients ?? [];

  const stats = useMemo(() => {
    const active = clients.filter((c: any) => c.active).length;
    const outstanding = clients.filter((c: any) => c.outstanding_cents > 0).length;
    const owedTotal = clients.reduce(
      (sum: number, c: any) => sum + (c.outstanding_cents ?? 0),
      0,
    );
    const atRisk = clients.filter((c: any) => (c.churn_score ?? 0) >= 60).length;
    return { total: clients.length, active, outstanding, owedTotal, atRisk };
  }, [clients]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter((c: any) => {
      if (type !== "all" && c.account_type !== type) return false;
      if (status === "active" && !c.active) return false;
      if (status === "inactive" && c.active) return false;
      if (status === "outstanding" && !(c.outstanding_cents > 0)) return false;
      if (status === "at_risk" && !((c.churn_score ?? 0) >= 60)) return false;
      if (!needle) return true;
      const hay = [c.display_name, c.primary_email, c.primary_phone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return hay.includes(needle);
    });
  }, [clients, q, status, type]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Clients</h1>
          <p className="text-sm text-muted-foreground">
            {stats.total} total · {stats.active} active
          </p>
        </div>
        <Link to="/clients/new">
          <Button>New client</Button>
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Users className="h-4 w-4" /> Active
          </div>
          <p className="mt-1 text-2xl font-semibold">{stats.active}</p>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Outstanding</div>
          <p className="mt-1 text-2xl font-semibold">{money(stats.owedTotal)}</p>
          <p className="text-xs text-muted-foreground">{stats.outstanding} clients</p>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <AlertTriangle className="h-4 w-4" /> At churn risk
          </div>
          <p className="mt-1 text-2xl font-semibold">{stats.atRisk}</p>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted-foreground">Inactive</div>
          <p className="mt-1 text-2xl font-semibold">{stats.total - stats.active}</p>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-64">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, email or phone…"
            className="pl-8"
          />
        </div>
        <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
          <SelectTrigger className="w-44"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
            <SelectItem value="outstanding">Has balance</SelectItem>
            <SelectItem value="at_risk">At churn risk</SelectItem>
          </SelectContent>
        </Select>
        <Select value={type} onValueChange={(v) => setType(v as TypeFilter)}>
          <SelectTrigger className="w-40"><SelectValue placeholder="Type" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All types</SelectItem>
            <SelectItem value="residential">Residential</SelectItem>
            <SelectItem value="commercial">Commercial</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {isLoading ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : !filtered.length ? (
        <div className="rounded-lg border border-dashed bg-card p-10 text-center">
          <p className="text-muted-foreground">
            {clients.length ? "No clients match those filters." : "No clients yet."}
          </p>
          {!clients.length && (
            <Link to="/clients/new" className="mt-3 inline-block">
              <Button size="sm">Create the first one</Button>
            </Link>
          )}
        </div>
      ) : (
        <>
          {/* Mobile: stacked cards */}
          <div className="space-y-3 sm:hidden">
            {filtered.map((c: any) => (
              <Link
                key={c.id}
                to="/clients/$clientId"
                params={{ clientId: c.id }}
                className="block rounded-lg border bg-card p-4 hover:bg-muted/30"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{c.display_name}</span>
                      <Badge variant={c.account_type === "commercial" ? "default" : "secondary"} className="text-[10px]">
                        {c.account_type}
                      </Badge>
                      {(c.churn_score ?? 0) >= 60 && (
                        <Badge variant="destructive" className="text-[10px]">At risk</Badge>
                      )}
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground truncate">{c.primary_email ?? "—"}</div>
                    <div className="text-xs text-muted-foreground">{c.primary_phone ?? ""}</div>
                  </div>
                  <div className="text-right">
                    {c.active ? (
                      <span className="text-xs text-emerald-600">Active</span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Inactive</span>
                    )}
                    {/* Show owed and credit distinctly and labeled — a client
                        can carry both at once (finding #22). */}
                    <div className="mt-1 space-y-0.5 text-sm">
                      {c.outstanding_cents > 0 && (
                        <div className="font-medium text-amber-600">
                          {money(c.outstanding_cents)} <span className="text-[11px] font-normal">owed</span>
                        </div>
                      )}
                      {c.credit_balance_cents > 0 && (
                        <div className="text-emerald-600">
                          +{money(c.credit_balance_cents)} <span className="text-[11px] text-emerald-700/70">credit</span>
                        </div>
                      )}
                      {!(c.outstanding_cents > 0) && !(c.credit_balance_cents > 0) && (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="mt-2 flex gap-3 text-xs text-muted-foreground">
                  <span>{c.dog_count} dogs</span>
                  <span>{c.active_subscription_count} subs</span>
                </div>
              </Link>
            ))}
          </div>

          {/* Desktop: table */}
          <div className="hidden overflow-x-auto rounded-lg border bg-card sm:block">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Type</th>
                  <th className="px-4 py-2 font-medium">Dogs</th>
                  <th className="px-4 py-2 font-medium">Subs</th>
                  <th className="px-4 py-2 font-medium">Frequency</th>
                  <th className="px-4 py-2 font-medium">Balance</th>
                  <th className="px-4 py-2 font-medium">Contact</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c: any) => (
                  <tr key={c.id} className="border-t hover:bg-muted/30">
                    <td className="px-4 py-3">
                      <Link
                        to="/clients/$clientId"
                        params={{ clientId: c.id }}
                        className="font-medium hover:underline"
                      >
                        {c.display_name}
                      </Link>
                      {(c.churn_score ?? 0) >= 60 && (
                        <Badge variant="destructive" className="ml-2 text-[10px]">
                          At risk
                        </Badge>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={c.account_type === "commercial" ? "default" : "secondary"}>
                        {c.account_type}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{c.dog_count}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {c.active_subscription_count}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {(c.frequencies ?? []).length
                        ? (c.frequencies as string[]).map((f) => f.replace("_", "-")).join(", ")
                        : "—"}
                    </td>
                    <td className="px-4 py-3">
                      {c.outstanding_cents > 0 ? (
                        <span className="font-medium text-amber-600">
                          {money(c.outstanding_cents)}
                        </span>
                      ) : c.credit_balance_cents > 0 ? (
                        <span className="text-emerald-600">
                          +{money(c.credit_balance_cents)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      <div className="truncate max-w-[220px]">{c.primary_email ?? "—"}</div>
                      <div className="text-xs">{c.primary_phone ?? ""}</div>
                    </td>
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
        </>
      )}
    </div>
  );
}
