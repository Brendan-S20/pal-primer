// Reviews & referrals tab (QA round 8): engagement blocks split out of
// Communication, which now holds messaging only. This tab owns the portal
// status panel, review requests, and referrals.
import { linkUrl } from "@/lib/app-origin";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { ExternalLink, KeyRound, Link2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusChip } from "@/components/client-detail/primitives";
import { getMyOrg } from "@/lib/org.functions";
import {
  regeneratePortalLink,
  readPortalVerificationCode,
  getClientPortalChannels,
} from "@/lib/clients.functions";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { ReviewsReferralPanel } from "@/components/client-detail/comms-panels";
import { formatPhone } from "@/lib/format";

export function ReviewsReferralsTab({
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
      {canBill && client.portal_token && <PortalStatusPanel client={client} clientId={clientId} />}

      <ReviewsReferralPanel client={client} />
    </div>
  );
}

// ── Compact portal status (moved from the Communication tab) ────────────────

function PortalStatusPanel({ client, clientId }: { client: any; clientId: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [token, setToken] = useState<string>(client.portal_token);
  const [code, setCode] = useState<string | null>(null);
  const regenFn = useServerFn(regeneratePortalLink);
  const readCodeFn = useServerFn(readPortalVerificationCode);
  const channelsFn = useServerFn(getClientPortalChannels);
  const orgFn = useServerFn(getMyOrg);
  const { data: orgData } = useQuery({
    queryKey: ["my-org"],
    queryFn: () => orgFn(),
    staleTime: 60_000,
  });
  // What the portal can ACTUALLY deliver a code to (SMS only when Twilio is
  // configured), so the copy never promises a texted code the portal won't
  // send (G2 channel mismatch).
  const { data: channelData } = useQuery({
    queryKey: ["portal-channels", clientId],
    queryFn: () => channelsFn({ data: { clientId } }),
    staleTime: 60_000,
  });
  const slug = (orgData?.organization as any)?.portal_slug as string | undefined;
  // linkUrl(), not the page origin — this goes to a customer and the native
  // binary's origin is `capacitor://localhost`.
  const url = linkUrl(slug ? `/portal/${slug}/${token}` : `/portal/${token}`);

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

  // Describe only the channels the portal will really use. Falls back to the
  // contact-on-file wording until the deliverability check resolves.
  const channels = channelData?.channels;
  // Email on file and no provider to send through: the code is not emailed,
  // and the panel says so rather than "emailed to" (#612).
  const emailNotSent = !!channelData?.emailOff && !!client.primary_email;
  const verifyDest = channels
    ? channels.length === 0
      ? emailNotSent
        ? "not emailed: email is off. Copy the link and send it yourself, or read them a code"
        : "office-read code (no deliverable phone or email on file)"
      : [
          channels.includes("sms") && client.primary_phone
            ? `texted to ${formatPhone(client.primary_phone)}`
            : null,
          channels.includes("email") && client.primary_email
            ? `emailed to ${client.primary_email}`
            : null,
        ]
          .filter(Boolean)
          .join(" or ") + (emailNotSent ? " (not emailed: email is off)" : "")
    : // Not "emailed to" before the check answers: it may be off.
      client.primary_email
      ? `to ${client.primary_email}`
      : "office-read code";

  return (
    <section className="rounded-lg border bg-card shadow-sm p-5">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        {/* `verifyDest` ends in the client's email address, one unbreakable
            token whose min-content width is the whole thing — without `min-w-0`
            this column is never laid out narrower than it and the Open / Copy
            link / Regenerate cluster beside it goes over the right edge of a
            phone. `break-words` then breaks the address rather than the
            sentence, which has to stay readable: it is how the office confirms
            where the code was sent. */}
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Client portal</h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-sm">
            <StatusChip status="enabled" />
            <span className="min-w-0 break-words text-xs text-muted-foreground">
              Sign-in code {verifyDest}
            </span>
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
          <Button
            size="sm"
            variant="outline"
            onClick={() => window.open(url, "_blank", "noopener")}
          >
            <ExternalLink className="mr-1 h-3.5 w-3.5 shrink-0" /> Open
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
            <Link2 className="mr-1 h-3.5 w-3.5 shrink-0" /> Copy link
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              // Sensitive: this hands out a working sign-in code. Require an
              // explicit confirmation that the client asked for it, and note
              // that the reveal is logged to Activity (G2).
              if (
                await confirm({
                  title: "Read a sign-in code to this client?",
                  description:
                    "Only do this when the client is on the phone and has asked us to read them a code. It's a one-time code that signs them into their portal. This reveal is recorded in the client's Activity with your name.",
                  confirmLabel: "Read code aloud",
                })
              )
                codeMut.mutate();
            }}
            disabled={codeMut.isPending}
          >
            <KeyRound className="mr-1 h-3.5 w-3.5 shrink-0" />
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
            <RefreshCw className="mr-1 h-3.5 w-3.5 shrink-0" />
            {regenMut.isPending ? "Regenerating…" : "Regenerate"}
          </Button>
        </div>
      </div>
    </section>
  );
}
