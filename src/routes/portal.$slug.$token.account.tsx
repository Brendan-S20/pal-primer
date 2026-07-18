import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Gift, Bell, CalendarClock, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { PushToggle } from "@/components/PushToggle";
import { usePortalCtx, ReferralCard, EmptyBox } from "@/lib/portal-ui";
import {
  portalSelfServeOptions,
  portalRequestVacationHold,
  portalChangeFrequency,
} from "@/lib/portal.functions";

export const Route = createFileRoute("/portal/$slug/$token/account")({
  component: PortalAccount,
});

const FREQ_LABELS: Record<string, string> = {
  weekly: "Weekly",
  biweekly: "Every 2 weeks",
  twice_weekly: "Twice a week",
  monthly: "Monthly",
};

function PortalAccount() {
  const { token, clientQ, referralQ } = usePortalCtx();
  const c = clientQ.data as any;
  const isCommercial = c?.account_type === "commercial";

  return (
    <div className="space-y-6">
      <SelfServeSection token={token} />
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

// Finding #36: render the vacation-hold and change-frequency controls only when
// the owner has enabled the matching self-serve permission.
function SelfServeSection({ token }: { token: string }) {
  const optsFn = useServerFn(portalSelfServeOptions);
  const holdFn = useServerFn(portalRequestVacationHold);
  const freqFn = useServerFn(portalChangeFrequency);
  const optsQ = useQuery({ queryKey: ["portal-selfserve", token], queryFn: () => optsFn({ data: { token } }) });
  const opts = optsQ.data as any;

  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [freq, setFreq] = useState("");

  const holdMut = useMutation({
    mutationFn: () => holdFn({ data: { token, startDate: start, endDate: end } }),
    onSuccess: (r: any) => {
      toast.success(`Vacation hold set. ${r.skippedCount ?? 0} visit(s) skipped.`);
      setStart(""); setEnd("");
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const freqMut = useMutation({
    mutationFn: () => freqFn({ data: { token, subscriptionId: opts.subscription.id, frequency: freq as any } }),
    onSuccess: (r: any) => {
      toast.success(
        r?.status === "requested"
          ? "Change request sent — the office will review it."
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
            <CalendarClock className="h-4 w-4" /> Vacation hold
          </h2>
          <div className="rounded-md border bg-card p-4 text-sm">
            <p className="mb-3 text-muted-foreground">Going away? Pause your service for a date range and we'll skip those visits.</p>
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">From</span>
                <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="rounded border bg-background px-2 py-1.5" />
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-muted-foreground">To</span>
                <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="rounded border bg-background px-2 py-1.5" />
              </label>
              <button
                onClick={() => holdMut.mutate()}
                disabled={!start || !end || holdMut.isPending}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {holdMut.isPending ? "Setting…" : "Request hold"}
              </button>
            </div>
          </div>
        </section>
      )}

      {opts.allowFrequencyChange && opts.subscription && (
        <section>
          <h2 className="mb-2 text-lg font-semibold flex items-center gap-2">
            <RefreshCw className="h-4 w-4" /> Service frequency
          </h2>
          <div className="rounded-md border bg-card p-4 text-sm">
            <p className="mb-3 text-muted-foreground">
              Currently <strong>{FREQ_LABELS[opts.subscription.frequency] ?? opts.subscription.frequency}</strong>.
            </p>
            <div className="flex flex-wrap items-end gap-3">
              <select
                value={freq || opts.subscription.frequency}
                onChange={(e) => setFreq(e.target.value)}
                className="rounded border bg-background px-2 py-1.5 text-sm"
              >
                {Object.entries(FREQ_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
              <button
                onClick={() => freqMut.mutate()}
                disabled={freqMut.isPending || (freq || opts.subscription.frequency) === opts.subscription.frequency}
                className="rounded bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {freqMut.isPending ? "Updating…" : "Update"}
              </button>
            </div>
          </div>
        </section>
      )}
    </>
  );
}
