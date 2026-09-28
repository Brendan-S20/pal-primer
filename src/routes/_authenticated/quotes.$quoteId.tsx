// One quote. A draft is still the office's and opens in the editor; anything
// sent is a document the customer has seen, shown read-only with what has
// happened to it and what can be done next: resend, copy the link, withdraw,
// duplicate, and, once accepted, turn it into work.
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Check, Copy, Send } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { QuoteDocument } from "@/components/quotes/QuoteDocument";
import { QuoteEditor, type QuoteEditorValues } from "@/components/quotes/QuoteEditor";
import { QuoteStatusBadge } from "@/components/quotes/QuoteStatusBadge";
import {
  deleteQuoteDraft,
  duplicateQuote,
  getQuote,
  sendQuote,
  withdrawQuote,
} from "@/lib/quotes.functions";
import { convertTarget, formatQuoteDay, sendResultMessage } from "@/lib/quotes";
import { formatDateTime } from "@/lib/format";

export const Route = createFileRoute("/_authenticated/quotes/$quoteId")({
  head: () => ({ meta: [{ title: "Quote · HoundStack" }] }),
  component: QuoteDetailPage,
});

function QuoteDetailPage() {
  const { quoteId } = Route.useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const getFn = useServerFn(getQuote);
  const sendFn = useServerFn(sendQuote);
  const withdrawFn = useServerFn(withdrawQuote);
  const deleteFn = useServerFn(deleteQuoteDraft);
  const duplicateFn = useServerFn(duplicateQuote);

  const q = useQuery({
    queryKey: ["quote", quoteId],
    queryFn: () => getFn({ data: { id: quoteId } }),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["quote", quoteId] });
    qc.invalidateQueries({ queryKey: ["quotes"] });
  };

  const sendM = useMutation({
    mutationFn: () => sendFn({ data: { id: quoteId } }),
    onSuccess: (r) => {
      const m = sendResultMessage(r);
      if (m.ok) toast.success(m.text);
      else toast.warning(m.text, { duration: 10_000 });
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const withdrawM = useMutation({
    mutationFn: () => withdrawFn({ data: { id: quoteId } }),
    onSuccess: () => {
      toast.success("Quote withdrawn. The link now shows it as expired.");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const deleteM = useMutation({
    mutationFn: () => deleteFn({ data: { id: quoteId } }),
    onSuccess: () => {
      toast.success("Draft deleted");
      qc.invalidateQueries({ queryKey: ["quotes"] });
      navigate({ to: "/quotes" });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const duplicateM = useMutation({
    mutationFn: () => duplicateFn({ data: { id: quoteId } }),
    onSuccess: ({ id }) => {
      toast.success("Copied into a new draft");
      qc.invalidateQueries({ queryKey: ["quotes"] });
      navigate({ to: "/quotes/$quoteId", params: { quoteId: id } });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const back = (
    <Link
      to="/quotes"
      className="inline-flex items-center text-sm text-muted-foreground hover:underline touch:min-h-11"
    >
      ← Quotes
    </Link>
  );

  if (q.isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (q.isError || !q.data) {
    return (
      <div className="space-y-3">
        {back}
        <p role="alert" className="text-sm text-destructive">
          {(q.error as Error)?.message ?? "Quote not found"}
        </p>
      </div>
    );
  }

  const { quote, lines, today, timezone } = q.data;
  const busy = sendM.isPending || withdrawM.isPending || deleteM.isPending || duplicateM.isPending;

  if (quote.rawStatus === "draft") {
    const initial: QuoteEditorValues = {
      mode: quote.clientId ? "client" : "prospect",
      clientId: quote.clientId ?? "",
      prospectName: quote.prospectName ?? "",
      prospectEmail: quote.prospectEmail ?? "",
      prospectPhone: quote.prospectPhone ?? "",
      leadId: quote.leadId,
      title: quote.title ?? "",
      message: quote.message ?? "",
      validUntil: quote.validUntil ?? "",
      lines: lines.map((l) => ({
        key: l.id,
        description: l.description,
        quantity: String(l.quantity),
        price: (l.unit_amount_cents / 100).toFixed(2),
        recurring: l.recurring,
      })),
    };
    return (
      <div className="mx-auto max-w-3xl space-y-5">
        {dialog}
        {back}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold">{quote.label}</h1>
            <QuoteStatusBadge status="draft" />
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={async () => {
              if (
                await confirm({
                  title: `Delete draft ${quote.label}?`,
                  description:
                    "Nobody outside the office has seen a draft, so nothing else changes.",
                  destructive: true,
                  confirmLabel: "Delete draft",
                })
              )
                deleteM.mutate();
            }}
          >
            Delete draft
          </Button>
        </div>
        <QuoteEditor
          key={`${quote.id}:${quote.createdAt}`}
          initial={initial}
          quoteId={quote.id}
          today={today}
          leadName={quote.leadName}
          onSaved={() => refresh()}
        />
      </div>
    );
  }

  const target = convertTarget({
    status: quote.status,
    client_id: quote.clientId,
    lead_id: quote.leadId,
    converted_at: quote.convertedAt,
  });
  const convert = () => {
    if (target.kind === "client") {
      navigate({
        to: "/clients/$clientId",
        params: { clientId: target.clientId },
        search: { tab: "services", fromQuote: quote.id },
      });
    } else if (target.kind === "prospect") {
      navigate({
        to: "/clients/new",
        search: { fromQuote: quote.id, fromLead: target.leadId ?? undefined },
      });
    }
  };
  const copyLink = () => {
    if (!quote.publicUrl) return;
    navigator.clipboard.writeText(quote.publicUrl).then(
      () => toast.success("Quote link copied"),
      () => toast.error("Copy failed"),
    );
  };

  const at = (ts: string | null) => (ts ? formatDateTime(ts, timezone) : "");
  const events: Array<{ key: string; label: string; when: string; detail?: string | null }> = [
    { key: "created", label: "Created", when: at(quote.createdAt) },
  ];
  if (quote.sentAt) events.push({ key: "sent", label: "Sent", when: at(quote.sentAt) });
  if (quote.acceptedAt)
    events.push({
      key: "accepted",
      label: "Accepted",
      when: at(quote.acceptedAt),
      detail: quote.acceptedName ? `Signed "${quote.acceptedName}"` : null,
    });
  if (quote.declinedAt)
    events.push({
      key: "declined",
      label: "Declined",
      when: at(quote.declinedAt),
      detail: quote.declineReason,
    });
  if (quote.status === "expired")
    events.push({
      key: "expired",
      label: quote.rawStatus === "expired" ? "Withdrawn" : "Expired",
      when:
        quote.rawStatus === "expired"
          ? ""
          : quote.validUntil
            ? `Valid until ${formatQuoteDay(quote.validUntil)}`
            : "",
    });
  if (quote.convertedAt)
    events.push({ key: "converted", label: "Turned into work", when: at(quote.convertedAt) });

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {dialog}
      {back}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold">{quote.label}</h1>
          <QuoteStatusBadge status={quote.status} />
        </div>
        <p className="break-words text-sm text-muted-foreground">
          For{" "}
          {quote.clientId ? (
            <Link
              to="/clients/$clientId"
              params={{ clientId: quote.clientId }}
              className="font-medium text-foreground underline"
            >
              {quote.recipientName}
            </Link>
          ) : (
            <span className="font-medium text-foreground">{quote.recipientName}</span>
          )}
          {quote.recipientEmail ? (
            <span className="break-all">{` · ${quote.recipientEmail}`}</span>
          ) : null}
          {!quote.clientId && " · not a client yet"}
        </p>

        <div className="flex flex-wrap gap-2">
          {target.kind !== "not-ready" && (
            <Button type="button" disabled={busy} onClick={convert}>
              <Check className="mr-1 h-4 w-4 shrink-0" />
              {target.kind === "client" ? "Convert to work" : "Convert to client"}
            </Button>
          )}
          {quote.convertedClientId && (
            <Button asChild variant="outline">
              <Link to="/clients/$clientId" params={{ clientId: quote.convertedClientId }}>
                Open client
              </Link>
            </Button>
          )}
          {quote.status === "sent" && (
            <Button
              type="button"
              variant={target.kind === "not-ready" ? "default" : "outline"}
              disabled={busy}
              onClick={() => sendM.mutate()}
            >
              <Send className="mr-1 h-4 w-4 shrink-0" />
              {sendM.isPending ? "Sending…" : "Resend"}
            </Button>
          )}
          {quote.publicUrl && (
            <Button type="button" variant="outline" onClick={copyLink}>
              <Copy className="mr-1 h-4 w-4 shrink-0" /> Copy link
            </Button>
          )}
          {quote.status === "sent" && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={async () => {
                if (
                  await confirm({
                    title: `Withdraw ${quote.label}?`,
                    description:
                      "The customer's link will show the quote as expired, and it can no longer be accepted.",
                    destructive: true,
                    confirmLabel: "Withdraw",
                  })
                )
                  withdrawM.mutate();
              }}
            >
              Withdraw
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => duplicateM.mutate()}
          >
            Duplicate
          </Button>
        </div>
      </div>

      <Card className="p-4 sm:p-6">
        <h2 className="text-sm font-medium">What has happened</h2>
        <ol className="mt-3 space-y-3">
          {events.map((e) => (
            <li key={e.key} className="flex gap-3 text-sm">
              <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
              <div className="min-w-0">
                <p>
                  <span className="font-medium">{e.label}</span>
                  {e.when ? <span className="text-muted-foreground">{` ${e.when}`}</span> : null}
                </p>
                {e.detail && (
                  <p className="whitespace-pre-wrap break-words text-muted-foreground">
                    {e.detail}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      </Card>

      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        What the customer sees
      </p>
      <QuoteDocument
        orgName={q.data.orgName}
        label={quote.label}
        status={quote.status}
        title={quote.title}
        recipientName={quote.recipientName}
        validUntil={quote.validUntil}
        message={quote.message}
        lines={lines.map((l) => ({
          description: l.description,
          quantity: l.quantity,
          unitAmountCents: l.unit_amount_cents,
          amountCents: l.amount_cents,
          recurring: l.recurring,
        }))}
      />
    </div>
  );
}
