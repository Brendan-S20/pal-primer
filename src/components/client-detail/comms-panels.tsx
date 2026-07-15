// Communication panels for the client detail page: SMS composer, review
// request / referral code, and the portal-access panel. Moved verbatim from
// the route file during the client-detail refactor (Stage 2) so the page
// itself stays a thin shell.
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { getMyOrg } from "@/lib/org.functions";
import { regeneratePortalLink, readPortalVerificationCode } from "@/lib/clients.functions";
import { sendReviewRequest, applyReferralCode } from "@/lib/reviews.functions";
import { sendSmsToClient, listClientMessages } from "@/lib/messages.functions";
import { formatDay } from "@/lib/format";
import { useConfirmDialog } from "@/components/ConfirmDialog";

export function MessageComposer({ client, bare = false }: { client: any; bare?: boolean }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listClientMessages);
  const sendFn = useServerFn(sendSmsToClient);
  const [body, setBody] = useState("");
  // Composer collapses to a single line until focused (spec 3.4).
  const [composerFocused, setComposerFocused] = useState(false);

  const messagesQ = useQuery({
    queryKey: ["client-messages", client.id],
    queryFn: () => listFn({ data: { clientId: client.id } }),
  });
  const messages: any[] = (messagesQ.data as any)?.messages ?? [];

  const sendMut = useMutation({
    mutationFn: () => sendFn({ data: { clientId: client.id, body: body.trim() } }),
    onSuccess: () => {
      setBody("");
      toast.success("Message sent");
      qc.invalidateQueries({ queryKey: ["client-messages", client.id] });
      qc.invalidateQueries({ queryKey: ["message-threads"] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const noPhone = !client.primary_phone;
  const shown = bare ? messages : messages.slice(-6);
  const Wrapper = bare ? "div" : "section";
  return (
    <Wrapper className={bare ? "" : "rounded-lg border bg-card shadow-sm p-5"}>
      {!bare && <h2 className="text-sm font-medium">Messages</h2>}
      {messages.length > 0 && (
        <ul className={`mt-3 space-y-2 overflow-y-auto ${bare ? "max-h-96" : "max-h-48"}`}>
          {shown.map((m) => (
            <li
              key={m.id}
              className={`rounded-md px-3 py-2 text-sm ${m.direction === "outbound" ? "bg-primary/10" : "bg-muted"}`}
            >
              <div className="text-xs uppercase text-foreground/70">
                {m.direction === "outbound" ? "Sent" : "Received"}
                {m.status ? ` · ${m.status}` : ""}
              </div>
              {m.body}
            </li>
          ))}
        </ul>
      )}
      <form
        className="mt-3 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (body.trim()) sendMut.mutate();
        }}
      >
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onFocus={() => setComposerFocused(true)}
          onBlur={() => setComposerFocused(false)}
          rows={composerFocused || body ? 3 : 1}
          maxLength={1500}
          placeholder={
            noPhone
              ? "Add a phone number to this client to send SMS."
              : messages.length === 0
                ? "Send the first message to this client…"
                : "Write a reply…"
          }
          disabled={noPhone}
        />
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Sends an SMS from your business number.
          </span>
          <Button type="submit" size="sm" disabled={noPhone || !body.trim() || sendMut.isPending}>
            {sendMut.isPending ? "Sending…" : "Send message"}
          </Button>
        </div>
      </form>
    </Wrapper>
  );
}

export function ReviewsReferralPanel({ client }: { client: any }) {
  const qc = useQueryClient();
  const sendReview = useServerFn(sendReviewRequest);
  const applyRef = useServerFn(applyReferralCode);
  const [code, setCode] = useState("");

  const askMut = useMutation({
    mutationFn: (force: boolean) => sendReview({ data: { clientId: client.id, force } }),
    onSuccess: () => {
      toast.success("Review request sent");
      qc.invalidateQueries({ queryKey: ["client", client.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const applyMut = useMutation({
    mutationFn: () => applyRef({ data: { clientId: client.id, code: code.trim() } }),
    onSuccess: (r) => {
      toast.success(
        `Referral applied: $${(r.reward_cents / 100).toFixed(2)} credited to both accounts`,
      );
      setCode("");
      qc.invalidateQueries({ queryKey: ["client", client.id] });
      qc.invalidateQueries({ queryKey: ["credit", client.id] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Copy failed"),
    );
  };

  const alreadyAsked = client.review_asked_at ? formatDay(client.review_asked_at) : null;

  return (
    <section className="rounded-lg border bg-card shadow-sm p-5">
      <h2 className="text-sm font-medium">Reviews & referrals</h2>

      <div className="mt-3 grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Referral code</div>
          <div className="flex items-center gap-2">
            <code className="rounded bg-muted px-2 py-1 font-mono text-sm">
              {client.referral_code ?? "-"}
            </code>
            {client.referral_code && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => copy(client.referral_code, "Code")}
              >
                Copy
              </Button>
            )}
          </div>
          {client.referred_by_client_id && (
            <p className="text-xs text-muted-foreground">
              Referred by another client on{" "}
              {client.referral_applied_at ? formatDay(client.referral_applied_at) : "-"}
            </p>
          )}
          {!client.referred_by_client_id && (
            <form
              className="flex items-center gap-2 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) applyMut.mutate();
              }}
            >
              <Input
                placeholder="Redeem referral code"
                aria-label="Redeem referral code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="h-8 max-w-[180px]"
              />
              <Button type="submit" size="sm" variant="outline" disabled={applyMut.isPending}>
                Apply
              </Button>
            </form>
          )}
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">Review request</div>
          {alreadyAsked ? (
            <p className="text-xs text-muted-foreground">Last asked {alreadyAsked}</p>
          ) : (
            <p className="text-xs text-muted-foreground">Not yet asked.</p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              onClick={() => askMut.mutate(false)}
              disabled={askMut.isPending || client.sms_opt_out || !client.primary_phone}
            >
              Send review SMS
            </Button>
            {alreadyAsked && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => askMut.mutate(true)}
                disabled={askMut.isPending || client.sms_opt_out || !client.primary_phone}
              >
                Send anyway
              </Button>
            )}
          </div>
          {(client.sms_opt_out || !client.primary_phone) && (
            <p className="text-xs text-amber-600">
              {client.sms_opt_out ? "Client opted out of SMS." : "No phone number on file."}
            </p>
          )}
        </div>
      </div>
    </section>
  );
}

export function PortalLinkPanel({ clientId, portalToken }: { clientId: string; portalToken: string }) {
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const [token, setToken] = useState(portalToken);
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
  // Canonical pretty URL; falls back to the legacy form only if the org has no
  // slug yet (the legacy path redirects to the pretty URL anyway).
  const path = slug ? `/portal/${slug}/${token}` : `/portal/${token}`;
  const url = `${origin}${path}`;

  const regenMut = useMutation({
    mutationFn: () => regenFn({ data: { clientId } }),
    onSuccess: (r) => {
      setToken(r.portalToken);
      setCode(null);
      qc.invalidateQueries({ queryKey: ["client", clientId] });
      toast.success(
        "Portal link regenerated. The old link and any signed-in devices are now locked out.",
      );
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const codeMut = useMutation({
    mutationFn: () => readCodeFn({ data: { clientId } }),
    onSuccess: (r) => setCode(r.code),
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mt-3 space-y-2 rounded-md border bg-muted/30 p-2 text-xs">
      {dialog}
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">Client portal link:</span>
        <code className="max-w-full truncate rounded bg-background px-2 py-1">{url}</code>
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
          Copy
        </Button>
        <a className="text-primary underline" href={path} target="_blank" rel="noreferrer">
          Open
        </a>
        <Button
          size="sm"
          variant="ghost"
          disabled={regenMut.isPending}
          onClick={async () => {
            if (
              await confirm({
                title: "Regenerate this client's portal link?",
                description:
                  "The current link stops working and any device already signed in is logged out. Use this if the link may have leaked.",
                destructive: true,
                confirmLabel: "Regenerate link",
              })
            ) {
              regenMut.mutate();
            }
          }}
        >
          {regenMut.isPending ? "Regenerating…" : "Regenerate link"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={codeMut.isPending}
          onClick={() => codeMut.mutate()}
        >
          {codeMut.isPending ? "…" : "Read verification code"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        The link opens the portal but the client must verify with a one-time code sent to their
        phone or email before seeing any account details.
      </p>
      {codeMut.isPending && (
        <p className="rounded bg-background p-2 text-sm text-muted-foreground">
          Generating a code…
        </p>
      )}
      {codeMut.isError && !codeMut.isPending && (
        <p className="rounded bg-destructive/10 p-2 text-sm text-destructive">
          Couldn't generate a code: {(codeMut.error as Error).message} Try again.
        </p>
      )}
      {code && !codeMut.isPending && (
        <p className="rounded bg-background p-2 font-mono text-sm">
          Read this code to the client (valid 10 min):{" "}
          <strong className="tracking-widest">{code}</strong>
        </p>
      )}
    </div>
  );
}
