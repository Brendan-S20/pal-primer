import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { getPlatformContext, updatePlatformPlan } from "@/lib/platform.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Pencil } from "lucide-react";

export const Route = createFileRoute("/platform/plans")({
  component: PlansPage,
});

type Plan = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  price_cents: number | null;
  annual_price_cents: number | null;
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
  // price_cents is ALWAYS the monthly base; annual plans additionally carry
  // their yearly base in annual_price_cents.
  if (p.interval === "year" && p.annual_price_cents !== null) {
    return `$${(p.annual_price_cents / 100).toFixed(0)}/year`;
  }
  if (p.price_cents !== null) return `$${(p.price_cents / 100).toFixed(0)}/month`;
  return "-";
}

function formatSeats(p: Plan): string {
  if (p.is_enterprise) return "Custom";
  if (p.included_seats === null) return "-";
  return `${p.included_seats} employee${p.included_seats === 1 ? "" : "s"} included`;
}

function formatOverage(p: Plan): string {
  if (p.is_enterprise) return "By contract";
  if (!p.price_per_seat_cents) return "-";
  return `$${(p.price_per_seat_cents / 100).toFixed(0)}/employee/${p.interval}`;
}

type EditForm = {
  name: string;
  description: string;
  price: string; // MONTHLY base dollars, raw string while typing
  annualPrice: string; // ANNUAL base dollars ($/year) — only used when interval=year
  includedSeats: string;
  pricePerSeat: string; // dollars per interval
  interval: "month" | "year";
  isActive: boolean;
  sortOrder: string;
};

function PlansPage() {
  const qc = useQueryClient();
  const ctxFn = useServerFn(getPlatformContext);
  useQuery({ queryKey: ["platform", "ctx"], queryFn: () => ctxFn() });
  const updateFn = useServerFn(updatePlatformPlan);

  const q = useQuery({
    queryKey: ["platform", "plans", "list"],
    queryFn: async () => {
      // Platform admins read the whole catalog (incl. deactivated plans) via
      // the "Platform admins manage plans" RLS policy.
      const { data, error } = await (supabase as any)
        .from("platform_plans")
        .select(
          "id, name, slug, description, price_cents, annual_price_cents, included_seats, price_per_seat_cents, is_enterprise, currency, interval, is_active, sort_order, stripe_price_id",
        )
        .order("sort_order", { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Plan[];
    },
  });

  const [editing, setEditing] = useState<Plan | null>(null);
  const [form, setForm] = useState<EditForm | null>(null);

  const openEdit = (p: Plan) => {
    setEditing(p);
    setForm({
      name: p.name,
      description: p.description ?? "",
      price: p.price_cents === null ? "" : (p.price_cents / 100).toFixed(2),
      annualPrice: p.annual_price_cents === null ? "" : (p.annual_price_cents / 100).toFixed(2),
      includedSeats: p.included_seats === null ? "" : String(p.included_seats),
      pricePerSeat:
        p.price_per_seat_cents === null ? "" : (p.price_per_seat_cents / 100).toFixed(2),
      interval: p.interval === "year" ? "year" : "month",
      isActive: p.is_active,
      sortOrder: String(p.sort_order),
    });
  };

  const save = useMutation({
    mutationFn: (v: {
      planId: string;
      name?: string;
      description?: string | null;
      priceCents?: number;
      annualPriceCents?: number | null;
      includedSeats?: number | null;
      pricePerSeatCents?: number | null;
      interval?: "month" | "year";
      isActive?: boolean;
      sortOrder?: number;
    }) => updateFn({ data: v }),
    onSuccess: () => {
      toast.success("Plan updated");
      qc.invalidateQueries({ queryKey: ["platform", "plans"] });
      setEditing(null);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  function submit() {
    if (!editing || !form) return;
    if (!form.name.trim()) {
      toast.error("Name can't be empty");
      return;
    }
    const dollars = (s: string): number | undefined => {
      if (s.trim() === "") return undefined;
      const n = Math.round(parseFloat(s) * 100);
      return Number.isFinite(n) ? n : undefined;
    };
    const price = dollars(form.price);
    const annualPrice = dollars(form.annualPrice);
    const perSeat = dollars(form.pricePerSeat);
    if (
      (price !== undefined && price < 0) ||
      (annualPrice !== undefined && annualPrice < 0) ||
      (perSeat !== undefined && perSeat < 0)
    ) {
      toast.error("Prices must be zero or more");
      return;
    }
    if (form.interval === "year" && annualPrice === undefined) {
      toast.error("Annual plans need an annual price ($/year)");
      return;
    }
    const seats = form.includedSeats.trim() === "" ? null : parseInt(form.includedSeats, 10);
    const sort = form.sortOrder.trim() === "" ? undefined : parseInt(form.sortOrder, 10);
    if (seats !== null && !Number.isFinite(seats)) {
      toast.error("Included employees must be a number");
      return;
    }
    save.mutate({
      planId: editing.id,
      name: form.name.trim(),
      description: form.description.trim() === "" ? null : form.description.trim(),
      // price_cents is ALWAYS monthly dollars; the annual base lives in
      // annual_price_cents. Annual dollars are never written into
      // price_cents/price_per_seat_cents (that corrupted MRR by 12x).
      ...(price !== undefined ? { priceCents: price } : {}),
      annualPriceCents: annualPrice ?? null,
      // Blank clears the nullable per-seat fields (matching description) —
      // omitting them would silently keep the old values.
      pricePerSeatCents: perSeat === undefined ? null : perSeat,
      includedSeats: seats,
      interval: form.interval,
      ...(sort !== undefined && Number.isFinite(sort) ? { sortOrder: sort } : {}),
      isActive: form.isActive,
    });
  }

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
                  <TableHead className="w-10"><span className="sr-only">Edit</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data ?? []).map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{p.name}</span>
                        {p.is_enterprise && <Badge variant="outline">Enterprise</Badge>}
                        {!p.is_active && <Badge variant="secondary">Inactive</Badge>}
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
                      {p.stripe_price_id ?? <span className="text-muted-foreground">-</span>}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Edit ${p.name}`}
                        onClick={() => openEdit(p)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {!q.isLoading && (q.data ?? []).length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-sm text-muted-foreground">
                      No plans yet.
                    </TableCell>
                  </TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit {editing?.name}</DialogTitle>
          </DialogHeader>
          {form && editing ? (
            <div className="space-y-3">
              <div>
                <Label>Name</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div>
                <Label>Description</Label>
                <Textarea
                  rows={3}
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Base price ($/month)</Label>
                  <Input
                    type="number" step="0.01" min="0"
                    value={form.price}
                    onChange={(e) => setForm({ ...form, price: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                </div>
                <div>
                  <Label>Per extra employee ($/{form.interval})</Label>
                  <Input
                    type="number" step="0.01" min="0"
                    value={form.pricePerSeat}
                    onChange={(e) => setForm({ ...form, pricePerSeat: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                </div>
              </div>
              {form.interval === "year" && (
                <div>
                  <Label>Annual price ($/year)</Label>
                  <Input
                    type="number" step="0.01" min="0"
                    value={form.annualPrice}
                    onChange={(e) => setForm({ ...form, annualPrice: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                  <p className="mt-1 text-xs text-muted-foreground">
                    The yearly base billed to annual tenants. The monthly base price above is
                    never multiplied — MRR uses this value divided by 12.
                  </p>
                </div>
              )}
              <div>
                <Label htmlFor="plan-billing-interval">Billing interval</Label>
                <select
                  id="plan-billing-interval"
                  value={form.interval}
                  onChange={(e) =>
                    setForm({ ...form, interval: e.target.value as "month" | "year" })
                  }
                  disabled={editing.is_enterprise}
                  className="mt-1 block w-full rounded-md border bg-background px-3 py-2 text-sm disabled:opacity-60"
                >
                  <option value="month">Monthly</option>
                  <option value="year">Annual</option>
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  Annual base prices are divided by 12 in platform MRR/ARR.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Included employees</Label>
                  <Input
                    type="number" step="1" min="0"
                    value={form.includedSeats}
                    onChange={(e) => setForm({ ...form, includedSeats: e.target.value })}
                    disabled={editing.is_enterprise}
                  />
                </div>
                <div>
                  <Label>Sort order</Label>
                  <Input
                    type="number" step="1"
                    value={form.sortOrder}
                    onChange={(e) => setForm({ ...form, sortOrder: e.target.value })}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <div>
                  <div className="text-sm font-medium">Active</div>
                  <div className="text-xs text-muted-foreground">
                    Inactive plans are hidden from signup and tenant billing.
                  </div>
                </div>
                <Switch
                  checked={form.isActive}
                  onCheckedChange={(v) => setForm({ ...form, isActive: v })}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                Price changes here update the catalog only — existing Stripe subscriptions keep
                their current price until re-mirrored.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setEditing(null)} disabled={save.isPending}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={save.isPending}>
              {save.isPending ? "Saving…" : "Save changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
