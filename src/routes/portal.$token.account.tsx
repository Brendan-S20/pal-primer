import { createFileRoute } from "@tanstack/react-router";
import { Gift, Bell } from "lucide-react";
import { PushToggle } from "@/components/PushToggle";
import { usePortalCtx, ReferralCard, EmptyBox } from "@/lib/portal-ui";

export const Route = createFileRoute("/portal/$token/account")({
  component: PortalAccount,
});

function PortalAccount() {
  const { token, clientQ, referralQ } = usePortalCtx();
  const c = clientQ.data as any;
  const isCommercial = c?.account_type === "commercial";

  return (
    <div className="space-y-6">
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Bell className="h-4 w-4" /> Notifications
        </h2>
        <div className="rounded-md border bg-card p-4 flex items-center justify-between gap-3 text-sm">
          <div>
            <div className="font-medium">Push notifications</div>
            <div className="text-xs text-muted-foreground">
              Visit confirmations, ETAs, weather reschedules.
            </div>
          </div>
          <PushToggle portalToken={token} />
        </div>
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Gift className="h-4 w-4" /> {isCommercial ? "Refer another property" : "Refer a neighbor"}
        </h2>
        {referralQ.data?.referral_code ? (
          <ReferralCard code={referralQ.data.referral_code}
            orgName={c?.org_name ?? ""}
            isCommercial={isCommercial} />
        ) : (
          <EmptyBox title="No referral code yet"
            body="We'll email you one to share once your account is fully set up." />
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Account</h2>
        <div className="rounded-md border bg-card p-4 text-sm space-y-2">
          <div><span className="text-muted-foreground">Name:</span> <strong>{c?.display_name}</strong></div>
          {c?.primary_email && <div><span className="text-muted-foreground">Email:</span> {c.primary_email}</div>}
          {c?.primary_phone && <div><span className="text-muted-foreground">Phone:</span> {c.primary_phone}</div>}
          <p className="mt-3 text-xs text-muted-foreground">
            Need to update your details? Reply to any {c?.org_name ?? "our"} email or text and we'll take care of it.
          </p>
        </div>
      </section>
    </div>
  );
}
