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
import { titleHead } from "@/lib/page-title";
import { Button } from "@/components/ui/button";
import { formatDateTime } from "@/lib/format";
import { activateTextingForOrg, listTextingReviews } from "@/lib/texting-ops.functions";
import { opsQueueNote, UNDER_REVIEW_LINE } from "@/lib/managed-texting";

export const Route = createFileRoute("/platform/addons")({
  head: () => titleHead("Add-ons", "Platform admin"),
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

      <TextingReviewQueue />
    </div>
  );
}

/**
 * site-r2-05: Managed texting registrations under review. The business sees
 * "Under review, usually ready shortly" until an admin presses Activate here;
 * texting switches on once the carrier has approved too (either order).
 * Stacked rows rather than a table, so it reads at 360px.
 */
function TextingReviewQueue() {
  const qc = useQueryClient();
  const listFn = useServerFn(listTextingReviews);
  const activateFn = useServerFn(activateTextingForOrg);
  const q = useQuery({ queryKey: ["platform", "texting-reviews"], queryFn: () => listFn() });
  const activate = useMutation({
    mutationFn: (organizationId: string) => activateFn({ data: { organizationId } }),
    onSuccess: (r) => {
      toast.success(
        r.live
          ? "Texting is live for this business"
          : "Activated. It switches on as soon as the carrier approves",
      );
      qc.invalidateQueries({ queryKey: ["platform", "texting-reviews"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const rows = q.data?.rows ?? [];
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Managed texting: under review</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Businesses that added Managed texting and submitted their details. Each one reads
          &ldquo;{UNDER_REVIEW_LINE}&rdquo; until you activate it here. Texting switches on once the
          carrier has approved as well.
        </p>
        {q.isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : q.isError ? (
          <p className="text-sm text-destructive">Could not load the queue.</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="texting-review-empty">
            Nothing under review.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border" data-testid="texting-review-queue">
            {rows.map((r) => (
              <li
                key={r.organizationId}
                className="flex flex-wrap items-center justify-between gap-3 p-3"
              >
                <div className="min-w-0">
                  <div className="truncate font-medium">{r.businessName}</div>
                  <div className="break-words text-xs text-muted-foreground">
                    {r.legalName && r.legalName !== r.businessName ? `${r.legalName} · ` : ""}
                    {r.phoneNumber ? <span dir="ltr">{r.phoneNumber}</span> : "No number yet"}
                    {r.submittedAt ? ` · submitted ${formatDateTime(r.submittedAt)}` : ""}
                  </div>
                  <div className="mt-1 text-xs">{opsQueueNote(r.status, r.opsApprovedAt)}</div>
                  {r.lastError && (
                    <div className="mt-1 break-words text-xs text-destructive">{r.lastError}</div>
                  )}
                </div>
                <Button
                  size="sm"
                  disabled={activate.isPending || (Boolean(r.opsApprovedAt) && r.status !== "approved")}
                  onClick={() => activate.mutate(r.organizationId)}
                >
                  {activate.isPending && activate.variables === r.organizationId
                    ? "Activating…"
                    : r.opsApprovedAt && r.status === "approved"
                      ? "Retry switch-on"
                      : r.opsApprovedAt
                        ? "Activated"
                        : "Activate"}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
