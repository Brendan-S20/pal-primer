import type { ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link } from "@tanstack/react-router";
import { Lock } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { getMyEntitlements } from "@/lib/entitlements.functions";
import {
  ENTITLEMENT_LABELS,
  TIER_NAMES,
  hasEntitlement,
  lowestTierWith,
  type Entitlement,
} from "@/lib/entitlements";

// BUILD-1 (client half) — the courteous face of the paywall.
//
// The actual enforcement is requireEntitlement() inside each feature's server
// functions; this component exists so a customer on Launch who opens Analytics
// sees an explanation instead of a wall of failed queries. Removing it would
// change nothing about who can reach the data (guardrail 10.4) — it would only
// make the product rude.
//
// Deliberately renders NOTHING until the answer is known. Flashing the real
// screen and then replacing it with a lock, or flashing the lock at a customer
// who has paid for the feature, are both worse than a beat of blank space.

export function PlanGate({
  entitlement,
  children,
}: {
  entitlement: Entitlement;
  children: ReactNode;
}) {
  const fn = useServerFn(getMyEntitlements);
  const q = useQuery({
    queryKey: ["my-entitlements"],
    queryFn: () => fn(),
    staleTime: 60_000,
  });

  if (q.isLoading) return null;

  // A failed lookup must not lock a paying customer out of what they bought.
  // The server-side check is the one that has to be right; if this one can't
  // answer, show the feature and let the server say no if it must.
  if (q.isError || !q.data) return <>{children}</>;

  if (hasEntitlement(q.data.tier, entitlement)) return <>{children}</>;
  return <UpgradeRequired entitlement={entitlement} currentTier={q.data.tier} />;
}

export function UpgradeRequired({
  entitlement,
  currentTier,
}: {
  entitlement: Entitlement;
  currentTier: string;
}) {
  const needed = lowestTierWith(entitlement);
  const feature = ENTITLEMENT_LABELS[entitlement];
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Card>
        <CardContent className="flex flex-col items-center gap-3 p-8 text-center">
          <div className="rounded-full bg-muted p-3">
            <Lock className="h-5 w-5 text-muted-foreground" />
          </div>
          <h1 className="text-xl font-semibold">{feature} isn&apos;t on your plan</h1>
          <p className="max-w-md text-sm text-muted-foreground">
            {needed ? (
              <>
                {feature} is included on{" "}
                <strong className="text-foreground">{TIER_NAMES[needed]}</strong> and above. This
                organization is currently on{" "}
                <strong className="text-foreground">
                  {TIER_NAMES[currentTier as keyof typeof TIER_NAMES] ?? currentTier}
                </strong>
                .
              </>
            ) : (
              <>{feature} is not available on any plan yet.</>
            )}
          </p>
          {needed && (
            <Button asChild className="mt-1">
              {/* Straight to the plan picker, not a generic "contact us" — the
                  upgrade is self-serve and the customer is one click from it. */}
              <Link to="/settings/billing">See plans</Link>
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
