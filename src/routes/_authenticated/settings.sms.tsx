import { createFileRoute } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState, useEffect } from "react";
import { getMyOrg } from "@/lib/org.functions";
import { updateOrgSmsFromNumber } from "@/lib/messages.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const inboundUrl = `${typeof window !== "undefined" ? window.location.origin : ""}/api/public/hooks/twilio?s=YOUR_TWILIO_INBOUND_SECRET`;

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">SMS settings</h1>
        <p className="text-sm text-muted-foreground">
          Send and receive text messages with clients through your Twilio number.
        </p>
      </div>

      <div className="space-y-3 rounded-lg border bg-card p-4">
        <label className="block text-sm font-medium">Sender number (E.164)</label>
        <Input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="+15558675310"
        />
        <p className="text-xs text-muted-foreground">
          The Twilio phone number all outbound SMS come from and inbound replies arrive on.
        </p>
        <Button onClick={() => save.mutate()} disabled={save.isPending}>
          Save
        </Button>
      </div>

      <div className="space-y-2 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">Inbound webhook</h2>
        <p className="text-sm text-muted-foreground">
          In the Twilio Console → Phone Numbers → your number, set{" "}
          <em>A message comes in</em> to <strong>HTTP POST</strong> at:
        </p>
        <code className="block break-all rounded bg-muted px-2 py-1 text-xs">{inboundUrl}</code>
        <p className="text-xs text-muted-foreground">
          Replace <code>YOUR_TWILIO_INBOUND_SECRET</code> with the value stored in your project
          secrets (already generated as <code>TWILIO_INBOUND_SECRET</code>). Twilio will forward
          replies here; STOP / START / HELP keywords are handled automatically.
        </p>
      </div>
    </div>
  );
}
