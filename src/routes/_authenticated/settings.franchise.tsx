import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Building2, LogOut } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import {
  getMyFranchiseMembership,
  joinFranchise,
  leaveFranchise,
} from "@/lib/franchise-membership.functions";

// BUILD-6 — the CHILD's side, and deliberately in Settings rather than on
// /franchise.
//
// /franchise is Enterprise-gated because rollup and royalty billing are what
// the pricing page sells at that tier. A franchisee is not buying that: they
// are a location someone else recruited, most likely on Launch or Growth. If
// joining lived behind the same gate, linking would be impossible unless every
// location independently bought the most expensive plan — so the feature would
// be unusable exactly where it is meant to be used.
//
// Leaving is ungated for a stronger reason still: a relationship you can enter
// and cannot exit is a trap, and it must not become one because a plan lapsed.

export const Route = createFileRoute("/_authenticated/settings/franchise")({
  head: () => ({ meta: [{ title: "Franchise · HoundStack" }] }),
  component: FranchiseSettings,
});

function FranchiseSettings() {
  const qc = useQueryClient();
  const getFn = useServerFn(getMyFranchiseMembership);
  const joinFn = useServerFn(joinFranchise);
  const leaveFn = useServerFn(leaveFranchise);
  const { confirm, dialog } = useConfirmDialog();
  const [code, setCode] = useState("");

  const q = useQuery({ queryKey: ["franchise", "membership"], queryFn: () => getFn() });

  const join = useMutation({
    mutationFn: () => joinFn({ data: { code: code.trim() } }),
    onSuccess: () => {
      toast.success("Joined the franchise");
      setCode("");
      qc.invalidateQueries({ queryKey: ["franchise"] });
      qc.invalidateQueries({ queryKey: ["org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const leave = useMutation({
    mutationFn: () => leaveFn(),
    onSuccess: () => {
      toast.success("Left the franchise");
      qc.invalidateQueries({ queryKey: ["franchise"] });
      qc.invalidateQueries({ queryKey: ["org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const m = q.data;

  return (
    <div className="max-w-2xl space-y-6">
      {dialog}
      <div>
        <h1 className="text-xl font-semibold">Franchise</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          If your business operates as a location within a larger franchise, this is where you
          connect to it.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : m?.isChild ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <Building2 className="h-4 w-4" /> Part of {m.parentName ?? "a franchise"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Your franchise can see this location&apos;s totals — active clients, visits, revenue,
              and outstanding balances. They cannot see individual client records.
            </p>
            <div className="rounded-md border bg-muted/40 p-3">
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                Royalty rate
              </div>
              {/* The franchisee can SEE what they owe even though only the
                  parent can set it (BUG-19 protects the column). Billing someone
                  a percentage they cannot look up would be indefensible. */}
              <div className="mt-0.5 text-lg font-medium tabular-nums">
                {m.royaltyPercent}% of collected revenue
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                Set by your franchise. Ask them if this doesn&apos;t look right.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={leave.isPending}
              onClick={async () => {
                const ok = await confirm({
                  title: "Leave this franchise?",
                  description: `${m.parentName ?? "The franchise"} will stop seeing this location's numbers, and your royalty rate resets to 0%. Royalty invoices already raised are not affected.`,
                  confirmLabel: "Leave franchise",
                  destructive: true,
                });
                if (ok) leave.mutate();
              }}
            >
              <LogOut className="mr-1 h-3 w-3" />
              {leave.isPending ? "Leaving…" : "Leave franchise"}
            </Button>
          </CardContent>
        </Card>
      ) : m?.isParent ? (
        <Card>
          <CardContent className="p-6 text-sm">
            <p className="font-medium">This organization is a franchise parent.</p>
            <p className="mt-1 text-muted-foreground">
              Manage your locations and royalty rates from the Franchise page. A parent
              can&apos;t also be a location within another franchise.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Join a franchise</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Enter the invitation code your franchise gave you. Nothing changes until you do —
              they can&apos;t link your business without this step.
            </p>
            <div>
              <Label htmlFor="franchise-code" className="text-xs">
                Invitation code
              </Label>
              <Input
                id="franchise-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. 7K2ZQ9M4XB"
                className="font-mono tracking-widest"
                autoComplete="off"
              />
            </div>
            <Button
              onClick={() => join.mutate()}
              disabled={join.isPending || code.trim().length < 6}
            >
              {join.isPending ? "Joining…" : "Join franchise"}
            </Button>
            <p className="text-xs text-muted-foreground">
              Joining lets your franchise see this location&apos;s totals and bill you a royalty
              percentage. You can leave at any time.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
