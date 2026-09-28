import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { AlertTriangle, Building2, CreditCard, Info } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { stripe1099kGuidance, routingAudience } from "@/lib/cpa-reports";
import {
  getPaymentRouting,
  setLocationChargebackPolicy,
  setLocationCollection,
  type LocationRouting,
} from "@/lib/franchise-routing.functions";

// BUILD-6 — where a franchise owner decides how each location's money moves.
//
// Two settings per location, and both have consequences that are invisible at
// the moment of clicking, so both are explained AT the switch rather than in
// documentation nobody opens:
//
//   who collects  → decides whose Stripe account takes the charge, and
//                   therefore who receives the 1099-K for the gross
//   who bears a   → decides how a refund or chargeback is apportioned on the
//   reversal        settlement
//
// The 1099-K text is the same function the tax reports use, so the two surfaces
// cannot tell an owner different things about their own filing.
//
// Switching collection asks for confirmation. Not because it is destructive —
// it is reversible in one click — but because it silently changes which bank
// account receives customer money starting with the very next payment, and
// nothing else on the screen would tell you that happened.

export function PaymentRouting() {
  const qc = useQueryClient();
  const getFn = useServerFn(getPaymentRouting);
  const collectFn = useServerFn(setLocationCollection);
  const policyFn = useServerFn(setLocationChargebackPolicy);
  const { confirm, dialog } = useConfirmDialog();
  const [busy, setBusy] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["franchise", "routing"],
    queryFn: () => getFn(),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["franchise"] });
    qc.invalidateQueries({ queryKey: ["tax-reports"] });
  };

  const collect = useMutation({
    mutationFn: (v: { organizationId: string; collectedByParent: boolean }) =>
      collectFn({ data: v }),
    onSuccess: (_r, v) => {
      toast.success(
        v.collectedByParent
          ? "This location's payments now come into your account"
          : "This location collects its own payments again",
      );
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => setBusy(null),
  });

  const policy = useMutation({
    mutationFn: (v: {
      organizationId: string;
      responsibility: "location" | "split" | "franchise";
    }) => policyFn({ data: v }),
    onSuccess: () => {
      toast.success("Saved. Reversals already recorded keep their original split.");
      invalidate();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = q.data;
  const anyByParent = !!data?.locations.some((l) => l.collectedByParent);

  const guidance = useMemo(
    () =>
      stripe1099kGuidance(
        routingAudience({ isFranchiseParent: true, collectsForAnyLocation: anyByParent }),
      ),
    [anyByParent],
  );

  async function toggleCollection(loc: LocationRouting, next: boolean) {
    const ok = await confirm({
      title: next
        ? `Collect ${loc.name}'s payments into your account?`
        : `Let ${loc.name} collect their own payments again?`,
      confirmLabel: next ? "Yes, we'll collect" : "Yes, they collect",
      description: next ? (
        <>
          <p>
            From the next payment onward, this location&apos;s customers pay into{" "}
            <strong>your</strong> Stripe account. You then settle with them each period: their
            revenue less royalty, less their share of any refunds.
          </p>
          <p>
            Your business will receive the 1099-K for this location&apos;s full card volume,
            including the part you pass back to them.
          </p>
          <p>
            Payments already taken are unaffected. Each one records who collected it at the time, so
            a settlement that spans this change still splits correctly.
          </p>
        </>
      ) : (
        <>
          <p>
            From the next payment onward, this location&apos;s customers pay into{" "}
            <strong>their own</strong> Stripe account, and they will receive their own 1099-K.
          </p>
          {!loc.hasOwnAccount && (
            <p className="font-medium text-destructive">
              They have not connected a Stripe account yet, so their customers will be unable to pay
              by card until they do. Talk to them before you switch this off.
            </p>
          )}
          <p>Anything you have already collected still settles as normal.</p>
        </>
      ),
    });
    if (!ok) return;
    setBusy(loc.organizationId);
    collect.mutate({ organizationId: loc.organizationId, collectedByParent: next });
  }

  if (q.isLoading) {
    return <p className="text-sm text-muted-foreground">Loading payment routing…</p>;
  }
  if (q.error) {
    return <p className="text-sm text-destructive">{(q.error as Error).message}</p>;
  }
  if (!data) return null;

  return (
    <>
      {dialog}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <CreditCard className="h-4 w-4" /> How payments come through
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            For each location, decide whether their customers pay into your account or their own,
            and who absorbs a refund or chargeback.
          </p>
        </CardHeader>
        <CardContent className="space-y-5">
          {!data.parentAccountReady && (
            <div className="flex gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">
                  {data.parentHasAccount
                    ? "Your Stripe account can't accept charges yet."
                    : "Your franchise hasn't connected a Stripe account."}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  Until it can, you can&apos;t collect on a location&apos;s behalf. A payment
                  routed to an account that isn&apos;t ready fails rather than quietly landing in
                  theirs. Finish setup on the Payments page.
                </p>
              </div>
            </div>
          )}

          {data.locations.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No locations yet. Open one, or invite an existing business with a code.
            </p>
          ) : (
            <div className="space-y-3">
              {data.locations.map((loc) => (
                <div key={loc.organizationId} className="rounded-md border p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <span className="truncate">{loc.name}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                        <Badge variant="secondary">{loc.royaltyPercent}% royalty</Badge>
                        {loc.collectedByParent ? (
                          <Badge>Paid into your account</Badge>
                        ) : loc.ownAccountReady ? (
                          <Badge variant="outline">Paid into their account</Badge>
                        ) : (
                          <Badge variant="destructive">
                            {loc.hasOwnAccount ? "Their Stripe isn't ready" : "No Stripe account"}
                          </Badge>
                        )}
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Label
                        htmlFor={`collect-${loc.organizationId}`}
                        className="text-xs text-muted-foreground"
                      >
                        We collect
                      </Label>
                      <Switch
                        id={`collect-${loc.organizationId}`}
                        checked={loc.collectedByParent}
                        disabled={
                          busy === loc.organizationId ||
                          // Can't route to an account that can't charge. The SQL
                          // refuses too; disabling here just explains it sooner.
                          (!loc.collectedByParent && !data.parentAccountReady)
                        }
                        onCheckedChange={(v) => toggleCollection(loc, v)}
                      />
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t pt-3">
                    <Label
                      htmlFor={`cb-${loc.organizationId}`}
                      className="text-xs text-muted-foreground"
                    >
                      Refunds &amp; chargebacks are borne by
                    </Label>
                    <Select
                      value={loc.chargebackResponsibility}
                      onValueChange={(v) =>
                        policy.mutate({
                          organizationId: loc.organizationId,
                          responsibility: v as "location" | "split" | "franchise",
                        })
                      }
                    >
                      <SelectTrigger id={`cb-${loc.organizationId}`} className="h-8 w-[16rem]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="location">The location, in full</SelectItem>
                        <SelectItem value="split">Split: you give back the royalty</SelectItem>
                        <SelectItem value="franchise">The franchise, in full</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="text-xs text-muted-foreground">
                      {CHARGEBACK_EXPLAINER[loc.chargebackResponsibility](loc.royaltyPercent)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="rounded-md border bg-muted/40 p-3">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Info className="h-4 w-4" /> {guidance.headline}
            </div>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {guidance.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted-foreground">
              Changing who bears a reversal is never retroactive. Every refund keeps the split that
              applied on the day it happened, so a statement you have already sent cannot change
              underneath you.
            </p>
          </div>

          <Button variant="outline" size="sm" asChild>
            <a href="/tax-reports">See what this means on your tax reports</a>
          </Button>
        </CardContent>
      </Card>
    </>
  );
}

/** Said in money terms rather than policy terms — "the location, in full" is a
 *  label; "on a $100 refund they lose $100 and still owe the $10 royalty" is
 *  the thing the owner is actually deciding. */
const CHARGEBACK_EXPLAINER: Record<string, (pct: number) => string> = {
  location: () => "On a $100 refund they lose the full $100 and still owe you the royalty.",
  split: (pct) =>
    `On a $100 refund you give back your $${pct.toFixed(0)} royalty and they absorb the rest.`,
  franchise: () => "On a $100 refund you absorb the full $100; they keep their share.",
};
