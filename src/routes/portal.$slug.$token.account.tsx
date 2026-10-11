import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Gift, Bell, CalendarClock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PushToggle } from "@/components/PushToggle";
import { Switch } from "@/components/ui/switch";
import { SMS_CONSENT_TEXT } from "@/lib/clients.functions";
import { usePortalCtx, ReferralCard, EmptyBox, VacationHoldCard } from "@/lib/portal-ui";
import { PORTAL_FREQUENCY_VALUES, cadenceLabel, frequencyLabel } from "@/lib/frequency-request";
import {
  portalSelfServeOptions,
  portalSetSmsConsent,
  portalChangeFrequency,
} from "@/lib/portal.functions";

export const Route = createFileRoute("/portal/$slug/$token/account")({
  component: PortalAccount,
});

// Canonical labels + the portal-selectable cadences (I3 shared map).
const FREQ_LABELS: Record<string, string> = Object.fromEntries(
  PORTAL_FREQUENCY_VALUES.map((v) => [v, frequencyLabel(v)]),
);

function PortalAccount() {
  const { token, clientQ, referralQ } = usePortalCtx();
  const c = clientQ.data as any;
  const isCommercial = c?.account_type === "commercial";

  return (
    <div className="space-y-6">
      <SelfServeSection token={token} />
      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Bell className="h-4 w-4 shrink-0" /> Notifications
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
        {/* Texts sit with push notifications because they are the same job to
            the person reading this — "how do you reach me". Consent is a
            separate legal fact from a preference toggle, which is why this one
            stores wording and a timestamp while push does not. */}
        <TextOptIn token={token} client={c} />
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
          <Gift className="h-4 w-4 shrink-0" />{" "}
          {isCommercial ? "Refer another property" : "Refer a neighbor"}
        </h2>
        {referralQ.data?.referral_code ? (
          <ReferralCard
            code={referralQ.data.referral_code}
            orgName={c?.org_name ?? ""}
            isCommercial={isCommercial}
          />
        ) : (
          <EmptyBox
            title="No referral code yet"
            body="We'll email you one to share once your account is fully set up."
          />
        )}
      </section>

      <section>
        <h2 className="mb-2 text-lg font-semibold">Account</h2>
        <div className="rounded-md border bg-card p-4 text-sm space-y-2">
          <div>
            <span className="text-muted-foreground">Name:</span> <strong>{c?.display_name}</strong>
          </div>
          {c?.primary_email && (
            <div>
              <span className="text-muted-foreground">Email:</span> {c.primary_email}
            </div>
          )}
          {c?.primary_phone && (
            <div>
              <span className="text-muted-foreground">Phone:</span> {c.primary_phone}
            </div>
          )}
          <p className="mt-3 text-xs text-muted-foreground">
            Need to update your details? Reply to any {c?.org_name ?? "our"} email or text and we'll
            take care of it.
          </p>
        </div>
      </section>
    </div>
  );
}

// Finding #36: render the vacation-hold and change-frequency controls only when
// the owner has enabled the matching self-serve permission.
//
// The vacation hold used to be reimplemented here, and the reimplementation
// lied. It toasted `Vacation hold set. ${r.skippedCount ?? 0} visit(s)
// skipped.` unconditionally — but when the org has auto-apply off, the RPC
// skips nothing and returns 0, so the customer read "hold set", ignored the
// zero, went away, and the truck came all week. It also had no minimum date
// (a hold could start in the past), no note field, and no idea whether the
// hold applies immediately or waits for the office.
//
// `VacationHoldCard` in portal-ui had all four right the whole time, and the
// shared `vacationMut` says "sent to the office for review" when nothing was
// skipped. This renders that one instead.
function SelfServeSection({ token }: { token: string }) {
  const { clientQ, vacationMut } = usePortalCtx();
  const c = clientQ.data as any;
  const optsFn = useServerFn(portalSelfServeOptions);
  const freqFn = useServerFn(portalChangeFrequency);
  const optsQ = useQuery({
    queryKey: ["portal-selfserve", token],
    queryFn: () => optsFn({ data: { token } }),
  });
  const opts = optsQ.data as any;

  const [freq, setFreq] = useState("");

  const freqMut = useMutation({
    mutationFn: () =>
      freqFn({ data: { token, subscriptionId: opts.subscription.id, frequency: freq as any } }),
    onSuccess: (r: any) => {
      toast.success(
        r?.status === "requested"
          ? "Change request sent. The office will review it."
          : "Service frequency updated.",
      );
      optsQ.refetch();
    },
    onError: (e) => toast.error((e as Error).message),
  });

  if (!opts || (!opts.allowVacationHold && !opts.allowFrequencyChange)) return null;

  return (
    <>
      {opts.allowVacationHold && (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <CalendarClock className="h-4 w-4 shrink-0" /> Vacation hold
          </h2>
          <VacationHoldCard
            autoApply={!!c?.auto_apply_changes}
            onSubmit={(v) => vacationMut.mutate(v)}
            pending={vacationMut.isPending}
          />
        </section>
      )}

      {opts.allowFrequencyChange && opts.subscription && (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <RefreshCw className="h-4 w-4 shrink-0" /> Service frequency
          </h2>
          <div className="rounded-md border bg-card p-4 text-sm">
            <p className="mb-3 text-muted-foreground">
              Currently{" "}
              <strong>
                {opts.subscription.weekdays?.length
                  ? cadenceLabel(opts.subscription.frequency, opts.subscription.weekdays)
                  : (FREQ_LABELS[opts.subscription.frequency] ?? opts.subscription.frequency)}
              </strong>
              .
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <select
                value={freq || opts.subscription.frequency}
                onChange={(e) => setFreq(e.target.value)}
                className="rounded border bg-background px-2 py-1.5 text-sm"
              >
                {Object.entries(FREQ_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
              <button
                onClick={() => freqMut.mutate()}
                disabled={
                  freqMut.isPending ||
                  (freq || opts.subscription.frequency) === opts.subscription.frequency
                }
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {freqMut.isPending ? "Sending…" : opts.autoApply ? "Update" : "Request change"}
              </button>
            </div>
            {!opts.autoApply && (
              <p className="mt-2 text-xs text-muted-foreground">
                Frequency changes are reviewed by the office before they take effect.
              </p>
            )}
          </div>
        </section>
      )}
    </>
  );
}

/**
 * The client opting themselves in to texts.
 *
 * This is the strongest consent evidence there is: the end user, on their own
 * authenticated session, ticking a box whose exact words are stored with the
 * timestamp. `portalSetSmsConsent` was written and wired to nothing — the
 * server function existed while this control did not, so the only way a client
 * could ever be textable was for staff to record consent on their behalf.
 */
function TextOptIn({ token, client }: { token: string; client: any }) {
  const qc = useQueryClient();
  const fn = useServerFn(portalSetSmsConsent);
  const optedIn = Boolean(client?.sms_consent_at) && !client?.sms_opt_out;

  const mut = useMutation({
    mutationFn: (optIn: boolean) => fn({ data: { token, optIn } }),
    onSuccess: (_r, optIn) => {
      toast.success(optIn ? "You're opted in to texts." : "You won't receive texts.");
      qc.invalidateQueries({ queryKey: ["portal", token, "client"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // Nothing to agree to without a number. Offering the toggle would let
  // somebody consent to messages at an address that does not exist.
  if (!client?.primary_phone) return null;

  return (
    <div className="mt-3 rounded-md border bg-card p-4 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-medium">Text messages</div>
          <div className="text-xs text-muted-foreground">
            Appointment reminders, visit updates and billing, to {client.primary_phone}.
          </div>
        </div>
        <Switch
          checked={optedIn}
          disabled={mut.isPending}
          onCheckedChange={(v) => mut.mutate(v)}
          aria-label="Receive text messages"
        />
      </div>
      {/* The words themselves, not a link to them. This is what gets stored as
          the consent record, and what a carrier asks to see. */}
      {!optedIn && <p className="mt-2 text-2xs text-muted-foreground">{SMS_CONSENT_TEXT}</p>}
    </div>
  );
}
