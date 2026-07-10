import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { getPlatformContext } from "@/lib/platform.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

export const Route = createFileRoute("/platform/plans")({
  component: PlansPage,
});

type Plan = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_cents: number | null;
  included_seats: number | null;
  price_per_seat_cents: number | null;
  is_enterprise: boolean;
  currency: string;
  interval: string;
  is_active: boolean;
  sort_order: number;
  stripe_price_id: string | null;
};

function formatBase(p: Plan): string {
  if (p.is_enterprise) return "Custom";
  if (p.price_cents !== null) return `$${(p.price_cents / 100).toFixed(0)}/${p.interval}`;
  return "—";
}

function formatSeats(p: Plan): string {
  if (p.is_enterprise) return "Custom";
  if (p.included_seats === null) return "—";
  return `${p.included_seats} employee${p.included_seats === 1 ? "" : "s"} included`;
}

function formatOverage(p: Plan): string {
  if (p.is_enterprise) return "By contract";
  if (!p.price_per_seat_cents) return "—";
  return `$${(p.price_per_seat_cents / 100).toFixed(0)}/employee/${p.interval}`;
}

function PlansPage() {
  const ctxFn = useServerFn(getPlatformContext);
  useQuery({ queryKey: ["platform", "ctx"], queryFn: () => ctxFn() });

  const q = useQuery({
    queryKey: ["platform", "plans", "list"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("platform_plans")
        .select(
          "id, name, slug, description, price_cents, included_seats, price_per_seat_cents, is_enterprise, currency, interval, is_active, sort_order, stripe_price_id",
        )
        .eq("is_active", true)
        .order("sort_order", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Plan[];
    },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Plans</h1>
        <p className="text-sm text-muted-foreground">
          Per-employee SaaS pricing, matching houndstack.com. Each tier includes a set number of
          employees; additional active employees are billed at the per-employee overage rate.
          <strong> Customers, dogs, jobs, routes, and zones are unlimited on every plan.</strong>{" "}
          New signups start on a 14-day free trial. Stripe products/prices are mirrored from here
          once the platform Stripe key is set.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Catalog</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Base price</TableHead>
                  <TableHead>Included employees</TableHead>
                  <TableHead>Additional employee</TableHead>
                  <TableHead>Customers</TableHead>
                  <TableHead>Stripe price</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        {p.is_enterprise && <Badge variant="outline">Enterprise</Badge>}
                      </div>
                      {p.description ? (
                        <div className="text-xs text-muted-foreground">{p.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{formatBase(p)}</TableCell>
                    <TableCell className="text-sm">{formatSeats(p)}</TableCell>
                    <TableCell className="text-sm">{formatOverage(p)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">Unlimited</TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.stripe_price_id ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                  </TableRow>
                ))}
                {!q.isLoading && (q.data ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-sm text-muted-foreground">
                      No plans yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
