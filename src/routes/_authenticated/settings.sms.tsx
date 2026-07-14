import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { getMyOrg } from "@/lib/org.functions";
import { updateOrgSmsFromNumber } from "@/lib/messages.functions";
import { getOrgTwilioSettings, setOrgTwilioSettings, clearOrgTwilioSettings } from "@/lib/twilio-settings.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/sms")({
  component: SmsSettings,
});

function SmsSettings() {
  const qc = useQueryClient();
  const orgFn = useServerFn(getMyOrg);
  const saveFn = useServerFn(updateOrgSmsFromNumber);
  const { data, isLoading } = useQuery({ queryKey: ["org"], queryFn: () => orgFn({}) });
  const [number, setNumber] = useState("");

  useEffect(() => {
    const n = (data?.organization as any)?.sms_from_number ?? "";
    setNumber(n);
  }, [data]);

  const save = useMutation({
    mutationFn: () => saveFn({ data: { number: number.trim() } }),
    onSuccess: () => {
      toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">SMS settings</h1>
        <p className="text-sm text-muted-foreground">
          Send and receive text messages with clients through your own Twilio account.
        </p>
      </div>

      <TwilioByok />

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <label className="block text-sm font-medium">Sender number (E.164)</label>
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="+15558675310"
        />
        <p className="text-xs text-muted-foreground">
          Your conversational number. Inbound replies arrive here and are matched to your org.
          When you connect your own Twilio above, this is kept in sync automatically.
        </p>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
      </div>
    </div>
  );
}

function TwilioByok() {
  const qc = useQueryClient();
  const getFn = useServerFn(getOrgTwilioSettings);
  const setFn = useServerFn(setOrgTwilioSettings);
  const clearFn = useServerFn(clearOrgTwilioSettings);
  const q = useQuery({ queryKey: ["org-twilio-settings"], queryFn: () => getFn() });
  const cfg = q.data as any;

  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [messagingServiceSid, setMessagingServiceSid] = useState("");

  useEffect(() => {
    if (cfg?.configured) {
      setAccountSid(cfg.accountSid ?? "");
      setFromNumber(cfg.smsFromNumber ?? "");
      setMessagingServiceSid(cfg.messagingServiceSid ?? "");
    }
  }, [cfg?.configured]);

  const saveMut = useMutation({
    mutationFn: () =>
      setFn({
        data: {
          accountSid: accountSid.trim(),
          authToken: authToken.trim(),
          smsFromNumber: fromNumber.trim() || undefined,
          messagingServiceSid: messagingServiceSid.trim() || undefined,
        },
      }),
    onSuccess: () => {
      toast.success("Twilio connected");
      setAuthToken("");
      qc.invalidateQueries({ queryKey: ["org-twilio-settings"] });
      qc.invalidateQueries({ queryKey: ["org"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const clearMut = useMutation({
    mutationFn: () => clearFn(),
    onSuccess: () => {
      toast.success("Twilio disconnected");
      setAuthToken("");
      qc.invalidateQueries({ queryKey: ["org-twilio-settings"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const inboundUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/api/public/hooks/twilio`;

  return (
    <div className="space-y-4 rounded-lg border bg-card p-4">
      <div>
        <h2 className="text-sm font-semibold">Bring your own Twilio (conversations)</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Your Twilio account powers <strong>two-way conversations</strong> with your clients
          (manual messages, replies, and the AI receptionist), sent from your own number.
          Automated notifications (reminders, on-my-way, review asks) and portal login codes are
          sent by HoundStack's platform sender, not your number.
        </p>
      </div>

      {q.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : (
        <>
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            {cfg?.configured ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  Connected · <span className="font-mono text-xs">{cfg.accountSid}</span>
                  {cfg.tokenLast4 ? <span className="text-muted-foreground"> · token ····{cfg.tokenLast4}</span> : null}
                </span>
                <Button variant="outline" size="sm" onClick={() => clearMut.mutate()} disabled={clearMut.isPending}>
                  Disconnect
                </Button>
              </div>
            ) : (
              <p className="text-muted-foreground">
                Not connected. Conversational SMS falls back to the platform sender until you connect your own Twilio.
              </p>
            )}
          </div>

          {/* One-click Twilio Connect (OAuth-style authorize flow) is parked
              until the Twilio Connect App is registered, same pattern as the
              QBO/Xero buttons. Manual credentials below keep working. */}
          {!cfg?.configured && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" disabled title="Coming soon">
                Connect with Twilio
                <span className="ml-1 text-[10px] font-normal opacity-80">soon</span>
              </Button>
              <span className="text-xs text-muted-foreground">
                One-click authorization is coming soon. Until then, paste your Account SID and Auth
                Token below.
              </span>
            </div>
          )}

          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (accountSid.trim() && authToken.trim()) saveMut.mutate();
            }}
          >
            <div>
              <Label htmlFor="tw-sid" className="text-xs">Account SID</Label>
              <Input id="tw-sid" value={accountSid} onChange={(e) => setAccountSid(e.target.value)} placeholder="AC…" autoComplete="off" />
            </div>
            <div>
              <Label htmlFor="tw-token" className="text-xs">Auth Token</Label>
              <Input id="tw-token" type="password" value={authToken} onChange={(e) => setAuthToken(e.target.value)} placeholder={cfg?.configured ? "•••• (unchanged, re-enter to update)" : "your Twilio auth token"} autoComplete="off" />
              <p className="mt-1 text-xs text-muted-foreground">Stored server-side; only the last 4 are shown after saving.</p>
            </div>
            <div>
              <Label htmlFor="tw-from" className="text-xs">Sender number (E.164)</Label>
              <Input id="tw-from" value={fromNumber} onChange={(e) => setFromNumber(e.target.value)} placeholder="+15558675310" />
            </div>
            <div>
              <Label htmlFor="tw-mg" className="text-xs">Messaging Service SID (optional)</Label>
              <Input id="tw-mg" value={messagingServiceSid} onChange={(e) => setMessagingServiceSid(e.target.value)} placeholder="MG…" autoComplete="off" />
              <p className="mt-1 text-xs text-muted-foreground">Recommended for US A2P 10DLC. Attach your registered campaign here.</p>
            </div>
            <Button type="submit" disabled={saveMut.isPending || !accountSid.trim() || !authToken.trim()}>
              {saveMut.isPending ? "Saving…" : cfg?.configured ? "Update Twilio" : "Connect Twilio"}
            </Button>
          </form>

          <div className="space-y-2 rounded-md border bg-muted/40 p-3">
            <h3 className="text-xs font-semibold">Inbound webhook (set this in your Twilio Console)</h3>
            <p className="text-xs text-muted-foreground">
              On your number, set <em>A message comes in</em> (and the Voice webhook) to <strong>HTTP POST</strong> at:
            </p>
            <code className="block break-all rounded bg-background px-2 py-1 text-xs">{inboundUrl}</code>
            <p className="text-xs text-muted-foreground">
              No secret in the URL. Inbound requests are verified against your Twilio Auth Token's signature.
            </p>
          </div>

          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
            <strong>US A2P 10DLC:</strong> register your own brand + campaign in your Twilio account, or US carriers
            may filter your conversational SMS. Until then, leave your own Twilio disconnected to keep using the
            platform sender.
          </p>
        </>
      )}
    </div>
  );
}
