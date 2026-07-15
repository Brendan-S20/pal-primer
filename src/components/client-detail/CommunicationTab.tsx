// Communication tab (QA follow-up 2.1): the four blocks that used to bloat
// Summary live here — full message thread, a compact portal status panel
// (not a raw URL block), review requests, and referrals.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ExternalLink, KeyRound, Link2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { getMyOrg } from "@/lib/org.functions";
import { regeneratePortalLink, readPortalVerificationCode } from "@/lib/clients.functions";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { MessageComposer, ReviewsReferralPanel } from "@/components/client-detail/comms-panels";
import { formatPhone } from "@/lib/format";

export function CommunicationTab({
  client,
  clientId,
  canBill,
}: {
  client: any;
  clientId: string;
  canBill: boolean;
}) {
  return (
    <div className="space-y-6">
      {/* Message thread + composer */}
      <section className="rounded-lg border bg-card p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Messages</h2>
          {client.primary_phone ? (
            <span className="text-xs text-muted-foreground">
              Sending to {formatPhone(client.primary_phone)}
              {client.sms_opt_out ? " · opted out of SMS" : ""}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">No phone number on file</span>
          )}
        </div>
        <div className="mt-2">
          <MessageComposer client={client} bare />
        </div>
      </section>

      {canBill && client.portal_token && (
        <PortalStatusPanel client={client} clientId={clientId} />
      )}

      <ReviewsReferralPanel client={client} />
    </div>
  );
}

// ── Compact portal status (replaces the raw-URL block) ─────────────────────

function PortalStatusPanel({ client, clientId }: { client: any; clientId: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [token, setToken] = useState<string>(client.portal_token);
  const [code, setCode] = useState<string | null>(null);
  const regenFn = useServerFn(regeneratePortalLink);
  const readCodeFn = useServerFn(readPortalVerificationCode);
  const orgFn = useServerFn(getMyOrg);
  const { data: orgData } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => orgFn(),
    staleTime: 60_000,
  });
  const slug = (orgData?.organization as any)?.portal_slug as string | undefined;
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}${slug ? `/portal/${slug}/${token}` : `/portal/${token}`}`;

  const regenMut = useMutation({
    mutationFn: () => regenFn({ data: { clientId } }),
    onSuccess: (r: any) => {
      setToken(r.portalToken);
      setCode(null);
      qc.invalidateQueries({ queryKey: ["client", clientId] });
      toast.success("Portal link regenerated");
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const codeMut = useMutation({
    mutationFn: () => readCodeFn({ data: { clientId } }),
    onSuccess: (r: any) => setCode(r.code),
    onError: (e: Error) => toast.error(e.message),
  });

  const verifyDest = client.primary_phone
    ? `code texted to ${formatPhone(client.primary_phone)}`
    : client.primary_email
      ? `code emailed to ${client.primary_email}`
      : "office-read code";

  return (
    <section className="rounded-lg border bg-card p-5">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Client portal</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="secondary">Enabled</Badge>
            <span className="text-xs text-muted-foreground">Sign-in verification: {verifyDest}</span>
          </div>
          {code && (
            <p className="mt-2 text-sm">
              One-time sign-in code to read aloud:{" "}
              <code className="rounded bg-muted px-2 py-0.5 font-mono text-base tracking-widest">
                {code}
              </code>
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" variant="outline" onClick={() => window.open(url, "_blank", "noopener")}>
            <ExternalLink className="mr-1 h-3.5 w-3.5" /> Open
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigator.clipboard.writeText(url).then(
                () => toast.success("Portal link copied"),
                () => toast.error("Copy failed"),
              )
            }
          >
            <Link2 className="mr-1 h-3.5 w-3.5" /> Copy link
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => codeMut.mutate()}
            disabled={codeMut.isPending}
          >
            <KeyRound className="mr-1 h-3.5 w-3.5" />
            {codeMut.isPending ? "Getting code…" : "Read sign-in code"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            onClick={async () => {
              if (
                await confirm({
                  title: "Regenerate portal link?",
                  description:
                    "The current link stops working immediately and any devices signed in with it are logged out. Share the new link with the client afterward.",
                  confirmLabel: "Regenerate link",
                })
              )
                regenMut.mutate();
            }}
            disabled={regenMut.isPending}
          >
            <RefreshCw className="mr-1 h-3.5 w-3.5" />
            {regenMut.isPending ? "Regenerating…" : "Regenerate"}
          </Button>
        </div>
      </div>
    </section>
  );
}
