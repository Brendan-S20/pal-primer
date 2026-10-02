import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listPlatformAddonsAdmin,
  setPlatformAddonStatus,
  type AddonStatus,
} from "@/lib/platform-addons-admin.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { Puzzle } from "lucide-react";

export const Route = createFileRoute("/platform/addons")({
  component: AddonsAdminPage,
});

const STATUS_META: Record<AddonStatus, { label: string; variant: "default" | "secondary" | "outline" }> = {
  active: { label: "Active", variant: "default" },
  coming_soon: { label: "Coming soon", variant: "outline" },
  disabled: { label: "Disabled", variant: "secondary" },
};

function formatPrice(cents: number, interval: string): string {
  const amount = `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
  return interval === "one_time" ? `${amount} one time` : `${amount}/${interval}`;
}

function AddonsAdminPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPlatformAddonsAdmin);
  const setStatusFn = useServerFn(setPlatformAddonStatus);

  const q = useQuery({ queryKey: ["platform", "addons", "admin"], queryFn: () => listFn() });

  const setStatus = useMutation({
    mutationFn: (v: { addonId: string; status: AddonStatus }) => setStatusFn({ data: v }),
    onSuccess: (_r, v) => {
      toast.success(
        v.status === "active"
          ? "Add-on enabled"
          : v.status === "coming_soon"
            ? "Add-on marked as coming soon"
            : "Add-on disabled",
      );
      qc.invalidateQueries({ queryKey: ["platform", "addons"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rows = q.data?.rows ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Add-ons</h1>
        <p className="text-sm text-muted-foreground">
          The upsell catalog tenants see on Settings → Plan &amp; billing. Active add-ons can be
          purchased; coming-soon ones are shown but not buyable; disabled ones are hidden. Changing
          status never affects existing subscriptions.
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
                  <TableHead>Add-on</TableHead>
                  <TableHead>Slug</TableHead>
                  <TableHead>Price</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Active subs</TableHead>
                  <TableHead className="w-44">Set status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((a) => {
                  const meta = STATUS_META[a.status] ?? STATUS_META.disabled;
                  return (
                    <TableRow key={a.id}>
                      <TableCell>
                        <div className="font-medium">{a.name}</div>
                        {a.description ? (
                          <div className="max-w-md text-xs text-muted-foreground">{a.description}</div>
                        ) : null}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{a.slug}</TableCell>
                      <TableCell className="text-sm">
                        {formatPrice(a.price_cents, a.billing_interval)}
                      </TableCell>
                      <TableCell>
                        <Badge variant={meta.variant}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">{a.active_subscriptions}</TableCell>
                      <TableCell>
                        <Select
                          value={a.status}
                          disabled={setStatus.isPending}
                          onValueChange={(v) => {
                            if (v !== a.status) {
                              setStatus.mutate({ addonId: a.id, status: v as AddonStatus });
                            }
                          }}
                        >
                          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="active">Enabled</SelectItem>
                            <SelectItem value="coming_soon">Coming soon</SelectItem>
                            <SelectItem value="disabled">Disabled</SelectItem>
                          </SelectContent>
                        </Select>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {q.isLoading ? (
                  <TableRow><TableCell colSpan={6}><Skeleton className="h-8 w-full" /></TableCell></TableRow>
                ) : rows.length === 0 ? (
                  <TableRow><TableCell colSpan={6} className="py-6">
                    <EmptyState
                      icon={<Puzzle className="h-5 w-5 shrink-0" />}
                      title="No add-ons yet"
                      description="Add-ons are seeded by migration; none exist in this environment."
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
