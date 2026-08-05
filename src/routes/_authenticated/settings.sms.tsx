import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { CheckCircle2, Clock } from "lucide-react";
import { getOrgTwilioSettings } from "@/lib/twilio-settings.functions";

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
// The sender-number field is gone too. It was editable because a customer's own
// number had to be declared; a subaccount number is issued during provisioning,
// so an editable field would just be a place to type something that gets
// overwritten.

export const Route = createFileRoute("/_authenticated/settings/sms")({
  component: SmsSettings,
});

function SmsSettings() {
  const getFn = useServerFn(getOrgTwilioSettings);
  const q = useQuery({ queryKey: ["org-twilio-settings"], queryFn: () => getFn() });

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-lg font-semibold">SMS settings</h2>
        <p className="text-sm text-muted-foreground">
          Two-way texting with clients runs on a HoundStack-managed number, provisioned for your
          organization. There is no Twilio account to connect and no carrier registration for you to
          file — we handle both.
        </p>
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
            Inbound replies arrive in Messages automatically. Automated notifications (reminders,
            on-my-way, review asks) and portal login codes are sent on HoundStack&apos;s platform
            sender rather than this number.
          </p>
        </div>
      ) : (
        <div className="space-y-3 rounded-lg border bg-card p-4 text-sm">
          <div className="flex items-start gap-2">
            <Clock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div>
              <div className="font-medium">Not yet available</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Conversational texting requires US carrier (10DLC) registration, which is in
                progress. It is a compliance queue paced by the registrar, not something that can be
                accelerated. Your number will be provisioned and appear here once it clears — no
                action needed from you.
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            In the meantime, portal login codes and automated notifications still go out on
            HoundStack&apos;s platform sender. Only staff↔client conversations are waiting on this.
          </p>
        </div>
      )}
    </div>
  );
}
