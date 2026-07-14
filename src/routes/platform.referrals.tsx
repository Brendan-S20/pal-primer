import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  listPlatformReferrals,
  updateReferralSettings,
  actOnReferral,
  type PlatformReferralRow,
} from "@/lib/platform-referrals.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Gift } from "lucide-react";

export const Route = createFileRoute("/platform/referrals")({
  component: ReferralsPage,
});

function money(cents: number | null | undefined) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    (cents ?? 0) / 100,
  );
}

// Derived display status: "eligible" is converted + past the holding window +
// not flagged — the rows Brendan should actually pay out.
function displayStatus(r: PlatformReferralRow): { label: string; tone: string } {
  if (r.status === "paid") return { label: "Paid", tone: "bg-emerald-600 text-white" };
  if (r.status === "rejected") return { label: "Rejected", tone: "" };
  if (r.status === "converted") {
    const eligible = r.eligible_at && new Date(r.eligible_at) <= new Date() && !r.flagged;
    return eligible
      ? { label: "Eligible for payout", tone: "bg-blue-600 text-white" }
      : { label: "Converted — holding", tone: "bg-blue-600/70 text-white" };
  }
  return { label: "Pending (not paying yet)", tone: "" };
}

function ReferralsPage() {
  const qc = useQueryClient();
  const listFn = useServerFn(listPlatformReferrals);
  const settingsFn = useServerFn(updateReferralSettings);
  const actFn = useServerFn(actOnReferral);

  const q = useQuery({ queryKey: ["platform", "referrals"], queryFn: () => listFn() });

  const [settingsDraft, setSettingsDraft] = useState<{
    percent: string;
    days: string;
    volume: string;
  } | null>(null);
  const [payTarget, setPayTarget] = useState<PlatformReferralRow | null>(null);
  const [payNote, setPayNote] = useState("");

  const saveSettings = useMutation({
    mutationFn: () =>
      settingsFn({
        data: {
          rewardPercent: Number(settingsDraft!.percent),
          holdingDays: Number(settingsDraft!.days),
          volumeFlagThreshold: Number(settingsDraft!.volume),
        },
      }),
    onSuccess: () => {
      toast.success("Referral settings saved");
      setSettingsDraft(null);
      qc.invalidateQueries({ queryKey: ["platform", "referrals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const act = useMutation({
    mutationFn: (v: {
      referralId: string;
      action: "mark_paid" | "reject" | "unflag";
      note?: string;
    }) => actFn({ data: v }),
    onSuccess: () => {
      setPayTarget(null);
      setPayNote("");
      qc.invalidateQueries({ queryKey: ["platform", "referrals"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const settings = q.data?.settings;
  const referrals = q.data?.referrals ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Gift className="h-4 w-4" /> Program settings
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!settings ? (
            <Skeleton className="h-10 w-full" />
          ) : settingsDraft ? (
            <div className="flex flex-wrap items-end gap-3">
              <div>
                <Label htmlFor="rp">Reward (% of first payment)</Label>
                <Input
                  id="rp"
                  type="number"
                  min="0"
                  max="100"
                  className="w-32"
                  value={settingsDraft.percent}
                  onChange={(e) => setSettingsDraft({ ...settingsDraft, percent: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="hd">Holding period (days)</Label>
                <Input
                  id="hd"
                  type="number"
                  min="0"
                  max="365"
                  className="w-32"
                  value={settingsDraft.days}
                  onChange={(e) => setSettingsDraft({ ...settingsDraft, days: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="vt">Flag volume above (30d)</Label>
                <Input
                  id="vt"
                  type="number"
                  min="1"
                  className="w-32"
                  value={settingsDraft.volume}
                  onChange={(e) => setSettingsDraft({ ...settingsDraft, volume: e.target.value })}
                />
              </div>
              <Button onClick={() => saveSettings.mutate()} disabled={saveSettings.isPending}>
                Save
              </Button>
              <Button variant="ghost" onClick={() => setSettingsDraft(null)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <span>
                Reward: <strong>{settings.reward_percent}%</strong> of first payment
              </span>
              <span>
                Holding period: <strong>{settings.holding_days} days</strong>
              </span>
              <span>
                Volume flag: <strong>{settings.volume_flag_threshold}+ / 30 days</strong>
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setSettingsDraft({
                    percent: String(settings.reward_percent),
                    days: String(settings.holding_days),
                    volume: String(settings.volume_flag_threshold),
                  })
                }
              >
                Edit
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Referrals</CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !referrals.length ? (
            <EmptyState
              icon={<Gift className="h-5 w-5" />}
              title="No referrals yet"
              description="When a tenant's /sign-up?ref= link brings in a new business, it shows up here with its conversion and payout status."
            />
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Referrer</TableHead>
                    <TableHead>Referred business</TableHead>
                    <TableHead>Signed up</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Reward owed</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {referrals.map((r) => {
                    const st = displayStatus(r);
                    const eligible =
                      r.status === "converted" &&
                      r.eligible_at &&
                      new Date(r.eligible_at) <= new Date() &&
                      !r.flagged;
                    return (
                      <TableRow key={r.id}>
                        <TableCell>{r.referrer_org_name}</TableCell>
                        <TableCell>
                          <div>{r.referred_org_name}</div>
                          <div className="text-xs text-muted-foreground">code {r.code_used}</div>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {new Date(r.created_at).toLocaleDateString()}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-col gap-1">
                            <Badge className={st.tone} variant={st.tone ? "default" : "outline"}>
                              {st.label}
                            </Badge>
                            {r.flagged && (
                              <span className="flex items-center gap-1 text-xs text-amber-700">
                                <AlertTriangle className="h-3 w-3" />{" "}
                                {r.flag_reason ?? "Flagged for review"}
                              </span>
                            )}
                            {r.status === "converted" &&
                              r.eligible_at &&
                              !eligible &&
                              !r.flagged && (
                                <span className="text-xs text-muted-foreground">
                                  eligible {new Date(r.eligible_at).toLocaleDateString()}
                                </span>
                              )}
                            {r.status === "paid" && r.paid_note && (
                              <span className="text-xs text-muted-foreground">{r.paid_note}</span>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          {r.status === "converted" || r.status === "paid" ? (
                            <div>
                              <div className="font-medium">{money(r.reward_cents)}</div>
                              <div className="text-xs text-muted-foreground">
                                {r.reward_percent}% of {money(r.first_payment_cents)}
                              </div>
                            </div>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-1">
                            {r.flagged && r.status !== "rejected" && (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => act.mutate({ referralId: r.id, action: "unflag" })}
                              >
                                Clear flag
                              </Button>
                            )}
                            {r.status === "converted" && (
                              <Button
                                size="sm"
                                disabled={!eligible}
                                title={
                                  eligible
                                    ? undefined
                                    : "Waiting on the holding period or a flag review"
                                }
                                onClick={() => setPayTarget(r)}
                              >
                                Mark paid
                              </Button>
                            )}
                            {(r.status === "pending" || r.status === "converted") && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => act.mutate({ referralId: r.id, action: "reject" })}
                              >
                                Reject
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!payTarget} onOpenChange={(o) => !o && setPayTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Mark {money(payTarget?.reward_cents)} paid to {payTarget?.referrer_org_name}?
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Phase 1 payouts move outside HoundStack (bank transfer, PayPal, check…). Record how it
            was paid so there's a trail.
          </p>
          <div className="space-y-2">
            <Label htmlFor="pay-note">Payout note (method / reference)</Label>
            <Input
              id="pay-note"
              value={payNote}
              onChange={(e) => setPayNote(e.target.value)}
              placeholder="e.g. PayPal 2026-07-14, txn #12345"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPayTarget(null)}>
              Cancel
            </Button>
            <Button
              disabled={act.isPending}
              onClick={() => {
                act.mutate(
                  { referralId: payTarget!.id, action: "mark_paid", note: payNote || undefined },
                  { onSuccess: () => toast.success("Marked paid") },
                );
              }}
            >
              Mark paid
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
