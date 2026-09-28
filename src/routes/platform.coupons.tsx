import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listPlatformCoupons,
  createPlatformCoupon,
  setPlatformCouponActive,
} from "@/lib/platform-billing.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { TicketPercent } from "lucide-react";
import { formatDay } from "@/lib/format";

export const Route = createFileRoute("/platform/coupons")({
  component: CouponsPage,
});

function CouponsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPlatformCoupons);
  const createFn = useServerFn(createPlatformCoupon);
  const toggleFn = useServerFn(setPlatformCouponActive);

  const q = useQuery({ queryKey: ["platform", "coupons"], queryFn: () => listFn() });

  const toggle = useMutation({
    mutationFn: (v: { id: string; is_active: boolean }) => toggleFn({ data: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["platform", "coupons"] }),
  });

  const create = useMutation({
    mutationFn: (v: any) => createFn({ data: v }),
    onSuccess: (r: any) => {
      toast.success(r?.stripe_mirrored ? "Coupon created and mirrored to Stripe" : "Coupon created (Stripe not configured)");
      qc.invalidateQueries({ queryKey: ["platform", "coupons"] });
      setOpen(false);
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({
    code: "",
    kind: "percent" as "percent" | "amount",
    value: "",
    duration: "once" as "once" | "repeating" | "forever",
    duration_in_months: "",
    max_redemptions: "",
    expires_at: "",
  });

  function submit() {
    const payload: any = {
      code: form.code,
      duration: form.duration,
      currency: "usd",
    };
    if (form.kind === "percent") payload.percent_off = Number(form.value);
    else payload.amount_off_cents = Math.round(Number(form.value) * 100);
    if (form.duration === "repeating") payload.duration_in_months = Number(form.duration_in_months);
    if (form.max_redemptions) payload.max_redemptions = Number(form.max_redemptions);
    if (form.expires_at) payload.expires_at = new Date(form.expires_at).toISOString();
    create.mutate(payload);
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Coupons</h1>
          <p className="text-sm text-muted-foreground">
            Discount codes for SaaS subscriptions. Mirrored to Stripe when the platform Stripe key is set.
          </p>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild><Button>New coupon</Button></DialogTrigger>
          <DialogContent>
            <DialogHeader><DialogTitle>Create coupon</DialogTitle></DialogHeader>
            <div className="space-y-3">
              <div><Label>Code</Label><Input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="LAUNCH20" /></div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Discount type</Label>
                  <Select value={form.kind} onValueChange={(v: any) => setForm({ ...form, kind: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">Percent off</SelectItem>
                      <SelectItem value="amount">Amount off (USD)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{form.kind === "percent" ? "Percent (1–100)" : "Amount ($)"}</Label>
                  <Input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Duration</Label>
                  <Select value={form.duration} onValueChange={(v: any) => setForm({ ...form, duration: v })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="once">Once</SelectItem>
                      <SelectItem value="repeating">Repeating</SelectItem>
                      <SelectItem value="forever">Forever</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                {form.duration === "repeating" ? (
                  <div><Label>Months</Label><Input type="number" value={form.duration_in_months} onChange={(e) => setForm({ ...form, duration_in_months: e.target.value })} /></div>
                ) : <div />}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div><Label>Max redemptions (optional)</Label><Input type="number" value={form.max_redemptions} onChange={(e) => setForm({ ...form, max_redemptions: e.target.value })} /></div>
                <div><Label>Expires (optional)</Label><Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} /></div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button onClick={submit} disabled={create.isPending || !form.code || !form.value}>Create</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">All coupons</CardTitle></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Code</TableHead>
                  <TableHead>Discount</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Redemptions</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Stripe</TableHead>
                  <TableHead>Active</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(q.data?.rows ?? []).map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-mono font-medium">{c.code}</TableCell>
                    <TableCell>{c.percent_off ? `${c.percent_off}%` : `$${((c.amount_off_cents ?? 0) / 100).toFixed(2)}`}</TableCell>
                    <TableCell className="text-sm">
                      {c.duration}{c.duration === "repeating" ? ` (${c.duration_in_months}mo)` : ""}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.times_redeemed}{c.max_redemptions ? ` / ${c.max_redemptions}` : ""}
                    </TableCell>
                    <TableCell className="text-sm">
                      {c.expires_at ? formatDay(c.expires_at) : "-"}
                    </TableCell>
                    <TableCell>
                      {c.stripe_coupon_id ? <Badge variant="outline">Mirrored</Badge> : <Badge variant="secondary">Local</Badge>}
                    </TableCell>
                    <TableCell>
                      <Switch checked={c.is_active} onCheckedChange={(v) => toggle.mutate({ id: c.id, is_active: v })} />
                    </TableCell>
                  </TableRow>
                ))}
                {q.isLoading ? (
                  <TableRow><TableCell colSpan={7}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
                ) : (q.data?.rows ?? []).length === 0 ? (
                  <TableRow><TableCell colSpan={7} className="py-6">
                    <EmptyState
                      icon={<TicketPercent className="h-5 w-5 shrink-0" />}
                      title="No coupons yet"
                      description="Create a discount code to run promos or comp specific tenants."
                    />
                  </TableCell></TableRow>
                ) : null}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
