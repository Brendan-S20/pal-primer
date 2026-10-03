import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useLocation } from "@tanstack/react-router";
import { AlertTriangle, XCircle } from "lucide-react";
import { getBillingBannerStatus } from "@/lib/billing.functions";
import { useMyRole } from "@/hooks/useMyRole";

/**
 * Sitewide banner shown to tenant users when their subscription is in a
 * non-healthy state. Visible to every org member (owner, office_manager,
 * dispatcher, tech) so nobody is blindsided when actions start failing;
 * the "Reactivate" / "Update payment" CTA is only rendered for owners,
 * who are the only role allowed to actually manage billing.
 *
 * EXCEPT a technician, since 2026-10-02 (launch pass, recommendation 6). "So
 * nobody is blindsided when actions start failing" does not reach them: a
 * past-due or canceled plan pauses growth (adding clients, AI), never the
 * route, so no action of a tech's starts failing, and the banner's only
 * instruction to them was to go and tell an owner something the owner is
 * already being told on every screen. It cost a tech the top of My Day.
 */
export function SuspensionBanner() {
  const location = useLocation();
  const { role } = useMyRole();
  const statusFn = useServerFn(getBillingBannerStatus);
  const { data } = useQuery({
    queryKey: ["billing-banner-status"],
    queryFn: () => statusFn(),
    staleTime: 60_000,
    retry: false,
    enabled: role !== null && role !== "tech",
  });

  if (role === null || role === "tech") return null;
  if (!data) return null;
  if (location.pathname.startsWith("/billing") || location.pathname.startsWith("/settings/billing")) return null;

  const isOwner = data.role === "owner";

  if (data.planStatus === "past_due") {
    return (
      <div className="flex items-center gap-3 border-b border-yellow-500/30 bg-yellow-500/10 px-4 py-2 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-600" />
        <span className="flex-1">
          <strong>Payment failed.</strong>{" "}
          {isOwner
            ? "Update your card to keep your subscription active."
            : "Ask an owner to update the card on file. Some actions may be blocked until it's resolved."}
        </span>
        {isOwner && (
          <Link to="/settings/billing" className="shrink-0 rounded-md bg-yellow-600 px-3 py-1 text-xs font-medium text-white hover:bg-yellow-700">
            Update payment
          </Link>
        )}
      </div>
    );
  }

  if (data.planStatus === "canceled") {
    return (
      <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm">
        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="flex-1">
          <strong>Subscription canceled.</strong>{" "}
          {isOwner
            ? "Reactivate to keep adding clients past the free tier."
            : "Ask an owner to reactivate the subscription. Some actions may be blocked until it's resolved."}
        </span>
        {isOwner && (
          <Link to="/settings/billing" className="shrink-0 rounded-md bg-destructive px-3 py-1 text-xs font-medium text-destructive-foreground hover:opacity-90">
            Reactivate
          </Link>
        )}
      </div>
    );
  }

  return null;
}
