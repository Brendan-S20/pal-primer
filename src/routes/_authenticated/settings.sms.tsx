import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Clock } from "lucide-react";
import { getOrgTwilioSettings } from "@/lib/twilio-settings.functions";
import { titleHead } from "@/lib/page-title";
import { ComingSoonBadge } from "@/components/ComingSoonBadge";

// IMP-9: this page used to be a "Bring your own Twilio" form — Account SID, Auth
// Token, Messaging Service SID, plus instructions for wiring an inbound webhook
// in the customer's own Twilio Console and a warning to register their own 10DLC
// brand. All of that is retired. Texting runs on a per-tenant Twilio SUBACCOUNT
// under HoundStack's 10DLC brand (Q-8), which we provision.
//
// Provisioning is BUILD-3 and sits in the carrier compliance queue, so the
// honest state today is "not yet available" — not a form that leads nowhere.
// Nobody loses anything: no organization had Twilio credentials configured and
// none had a sender number set, verified against live data.
//
// 2026-10-06: until then this page said automated notifications and portal
// codes went out on HoundStack's platform sender. They no longer do; a client
// is texted only from the business's own number (lib/twilio-credentials.server).
//
// The sender-number field is gone too. It was editable because a customer's own
// number had to be declared; a subaccount number is issued during provisioning,
// so an editable field would just be a place to type something that gets
// overwritten.

export const Route = createFileRoute("/_authenticated/settings/sms")({
  head: () => titleHead("SMS", "Settings"),
  component: SmsSettings,
});

function SmsSettings() {
  const getFn = useServerFn(getOrgTwilioSettings);
  const q = useQuery({ queryKey: ["org-twilio-settings"], queryFn: () => getFn() });

  return (
    <div className="space-y-6">
      <div>
        <h2 className="flex flex-wrap items-center gap-2 text-lg font-semibold">
          SMS settings
          {!q.isLoading && !q.data?.configured && <ComingSoonBadge />}
        </h2>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : q.data?.configured ? (
        <div className="space-y-3 rounded-lg border bg-card p-4 text-sm">
          <div className="flex items-start gap-2">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
            <div>
              <div className="font-medium">Texting is active</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Sender number:{" "}
                <span className="font-mono">{q.data.smsFromNumber ?? "being assigned"}</span>
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Inbound replies arrive in Messages automatically. Every text to your clients goes out
            from this number: messages from your staff, reminders, on-my-way notices, review asks
            and portal sign-in codes.
          </p>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border bg-card p-4 text-sm">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <div className="font-medium">Not yet available</div>
              <div className="mt-1 text-xs text-muted-foreground">
                {/* A-P0-1 (2026-10-09): the Twilio Specialist's exact wording. It
                    replaces both the header's "HoundStack-managed number" line
                    and the 10DLC-queue paragraph that stood here, and it sits in
                    this branch rather than under the heading because it says
                    "coming soon", which is only true until a number is issued. */}
                Client texting is coming soon. We&apos;ll ask for your business details and approval
                before registering your local number with carriers. Your number appears here after
                carrier approval, which can take several days.
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Until then, client updates and portal sign-in codes go by email. HoundStack&apos;s own
            number texts account holders only.
          </p>
        </div>
      )}
    </div>
  );
}
