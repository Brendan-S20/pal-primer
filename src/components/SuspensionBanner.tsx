import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Link, useLocation } from "@tanstack/react-router";
import { AlertTriangle, XCircle } from "lucide-react";
import { getBillingBannerStatus } from "@/lib/billing.functions";
import { useMyRole } from "@/hooks/useMyRole";
import { useDismissed } from "@/lib/dismissible";
import { DismissButton } from "@/components/DismissButton";

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
 *
 * DISMISSIBLE SINCE 2026-10-03 (owner: notices he has read should be able to
 * go away). Neither state is a lockout: past-due and canceled pause growth,
 * never the route, invoicing or the data. So the X hides it, pinned to the
 * plan status (a payment that fails and then a cancellation are two different
 * notices, and the second re-shows even if the first was put away), and it
 * comes back on its own: after a DAY for a failed payment, because Stripe is
 * retrying the card and the subscription ends if nobody acts, and after a
 * WEEK for a canceled plan, which is stable until somebody reactivates it.
 * Rule in src/lib/dismissible.ts.
 */
const SNOOZE_DAYS: Record<string, number> = { past_due: 1, canceled: 7 };

export function SuspensionBanner() {
  const location = useLocation();
  const { role, orgId } = useMyRole();
  const statusFn = useServerFn(getBillingBannerStatus);
  const { data } = useQuery({
    queryKey: ["billing-banner-status"],
    queryFn: () => statusFn(),
    staleTime: 60_000,
    retry: false,
    enabled: role !== null && role !== "tech",
  });

  const status = data?.planStatus;
  const nags = status === "past_due" || status === "canceled";
  const { dismissed, dismiss } = useDismissed("billing-status", nags ? status : null, {
    orgId,
    snoozeDays: nags ? SNOOZE_DAYS[status] : undefined,
  });

  if (role === null || role === "tech") return null;
  if (!data) return null;
  if (dismissed) return null;
  if (location.pathname.startsWith("/billing") || location.pathname.startsWith("/settings/billing")) return null;

  const isOwner = data.role === "owner";

  if (data.planStatus === "past_due") {
    return (
      <div className="flex items-center gap-3 border-b border-yellow-500/30 bg-yellow-500/10 py-2 ps-4 pe-1 text-sm">
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-600" />
        <span className="min-w-0 flex-1">
          <strong>Payment failed.</strong>{" "}
          {isOwner
            ? "Update your card to keep your subscription active."
            : "Ask an owner to update the card on file. Some actions may be blocked until it's resolved."}
        </span>
        {isOwner && (
          <Link to="/settings/billing" className="inline-flex shrink-0 items-center rounded-md bg-yellow-600 px-3 py-1 text-xs touch:min-h-11 font-medium text-white hover:bg-yellow-700">
            Update payment
          </Link>
        )}
        <DismissButton onClick={dismiss} label="Hide the payment notice" className="-my-2 -ms-2" />
      </div>
    );
  }

  if (data.planStatus === "canceled") {
    return (
      <div className="flex items-center gap-3 border-b border-destructive/30 bg-destructive/10 py-2 ps-4 pe-1 text-sm">
        <XCircle className="h-4 w-4 shrink-0 text-destructive" />
        <span className="min-w-0 flex-1">
          <strong>Subscription canceled.</strong>{" "}
          {isOwner
            ? "Reactivate to keep adding clients past the free tier."
            : "Ask an owner to reactivate the subscription. Some actions may be blocked until it's resolved."}
        </span>
        {isOwner && (
          <Link to="/settings/billing" className="inline-flex shrink-0 items-center rounded-md bg-destructive px-3 py-1 text-xs touch:min-h-11 font-medium text-destructive-foreground hover:opacity-90">
            Reactivate
          </Link>
        )}
        <DismissButton
          onClick={dismiss}
          label="Hide the subscription notice"
          className="-my-2 -ms-2"
        />
      </div>
    );
  }

  return null;
}
