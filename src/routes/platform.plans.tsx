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
  client_limit_min: number;
  client_limit_max: number | null;
  price_per_client_cents: number | null;
  price_cents: number | null;
  currency: string;
  interval: string;
  is_active: boolean;
  is_free: boolean;
  sort_order: number;
  stripe_price_id: string | null;
};

function formatBand(p: Plan): string {
  if (p.client_limit_max === null) return `${p.client_limit_min}+ clients`;
  return `${p.client_limit_min}–${p.client_limit_max} clients`;
}

function formatPrice(p: Plan): string {
  if (p.is_free) return "Free";
  if (p.price_per_client_cents !== null) return `$${(p.price_per_client_cents / 100).toFixed(2)}/client/${p.interval}`;
  if (p.price_cents !== null) return `$${(p.price_cents / 100).toFixed(0)}/${p.interval}`;
  return "—";
}

function PlansPage() {
  const ctxFn = useServerFn(getPlatformContext);
  useQuery({ queryKey: ["platform", "ctx"], queryFn: () => ctxFn() });

  const q = useQuery({
    queryKey: ["platform", "plans", "list"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("platform_plans")
        .select(
          "id, name, slug, description, client_limit_min, client_limit_max, price_per_client_cents, price_cents, currency, interval, is_active, is_free, sort_order, stripe_price_id",
        )
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
          SaaS plan catalog defined by <strong>active-client bands</strong>. Unlimited staff on every plan.
          Stripe products and prices are mirrored from here once the platform Stripe key is set (step 5).
        </p>
      </div>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">Catalog</CardTitle>
          <div className="text-xs text-muted-foreground">
            Editing lands with step 5 — awaiting pricing bands.
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Plan</TableHead>
                  <TableHead>Band</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Included</TableHead>
                  <TableHead>Stripe price</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="font-medium">{p.name}</div>
                      {p.description ? (
                        <div className="text-xs text-muted-foreground">{p.description}</div>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm">{formatBand(p)}</TableCell>
                    <TableCell className="text-sm">{formatPrice(p)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">Unlimited staff</TableCell>
                    <TableCell className="font-mono text-xs">
                      {p.stripe_price_id ?? <span className="text-muted-foreground">—</span>}
                    </TableCell>
                    <TableCell>
                      {p.is_active ? <Badge variant="default">Active</Badge> : <Badge variant="outline">Draft</Badge>}
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
