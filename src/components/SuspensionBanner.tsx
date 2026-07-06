import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useLocation } from "@tanstack/react-router";
import { AlertTriangle, XCircle } from "lucide-react";
import { getBillingStatus } from "@/lib/billing.functions";

/**
 * Sitewide banner shown to tenant users when their subscription is in a
 * non-healthy state. Hidden on /billing itself to avoid double-messaging.
 */
export function SuspensionBanner() {
  const location = useLocation();
  const statusFn = useServerFn(getBillingStatus);
  const { data } = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => statusFn(),
    staleTime: 60_000,
    retry: false,
  });

  if (!data) return null;
  if (location.pathname.startsWith("/billing")) return null;

  if (data.planStatus === "past_due") {
    return (
      <div className="flex items-center gap-3 border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-600" />
        <span className="flex-1">
          <strong>Payment failed.</strong> Update your card to keep your subscription active.
        </span>
        <Link to="/billing" className="shrink-0 rounded-md bg-yellow-600 px-3 py-1 text-xs font-medium text-white hover:bg-yellow-700">
          Update payment
        </Link>
      </div>
    );
  }

  if (data.planStatus === "canceled") {
    return (
      <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="flex-1">
          <strong>Subscription canceled.</strong> Reactivate to keep adding clients past the free tier.
        </span>
        <Link to="/billing" className="shrink-0 rounded-md bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90">
          Reactivate
        </Link>
      </div>
    );
  }

  return null;
}
