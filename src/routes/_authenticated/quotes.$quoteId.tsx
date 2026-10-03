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
import { DownloadPdfButton } from "@/components/DownloadPdfButton";
import { downloadQuotePdf } from "@/lib/document-pdf.functions";
import { appUrl } from "@/lib/app-origin";
import {
  createQuoteDepositInvoice,
  deleteQuoteDraft,
  duplicateQuote,
  getQuote,
  invoiceQuoteOneTimeCharges,
  sendQuote,
  withdrawQuote,
} from "@/lib/quotes.functions";
import { sendInvoiceEmail } from "@/lib/notifications.functions";
import {
  convertTarget,
  formatQuoteDay,
  formatQuoteMoney,
  quoteTotals,
  sendResultMessage,
} from "@/lib/quotes";
import { formatDateTime } from "@/lib/format";
import { pageTitle, useDocumentTitle } from "@/lib/page-title";

export const Route = createFileRoute("/_authenticated/quotes/$quoteId")({
  head: () => ({ meta: [{ title: pageTitle("Quote") }] }),
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
  const invoiceFn = useServerFn(invoiceQuoteOneTimeCharges);
  const depositFn = useServerFn(createQuoteDepositInvoice);
  const sendInvoiceFn = useServerFn(sendInvoiceEmail);
  const pdfFn = useServerFn(downloadQuotePdf);

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

  // The initial cleanup and anything else that is not a per-visit price. The
  // office presses this when the work is done: an open invoice is one
  // autopay will charge, so creating it at conversion would bill early.
  const invoiceM = useMutation({
    mutationFn: () => invoiceFn({ data: { id: quoteId } }),
    onSuccess: (r) => {
      if (r.created) toast.success("Invoiced the one-time charges");
      refresh();
      if (r.invoiceId) navigate({ to: "/invoices/$invoiceId", params: { invoiceId: r.invoiceId } });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // A prospect's deposit is invoiced at conversion, a client's at acceptance.
  // This is for when neither could: the same once-only database function.
  const depositM = useMutation({
    mutationFn: () => depositFn({ data: { id: quoteId } }),
    onSuccess: () => {
      toast.success("Deposit invoice made");
      refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const sendDepositM = useMutation({
    mutationFn: (invoiceId: string) => sendInvoiceFn({ data: { invoiceId } }),
    onSuccess: (r) =>
      toast.success(
        r.recipient ? `Deposit invoice emailed to ${r.recipient}` : "Deposit invoice emailed",
      ),
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

  // "Q-1042 · Quotes", from the label the heading prints.
  useDocumentTitle(q.data?.quote.label ? pageTitle(q.data.quote.label, "Quotes") : null);

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
  const busy =
    sendM.isPending ||
    withdrawM.isPending ||
    deleteM.isPending ||
    duplicateM.isPending ||
    invoiceM.isPending ||
    depositM.isPending ||
    sendDepositM.isPending;
  const oneTimeCents = quoteTotals(lines).oneTimeCents;
  const billTo = quote.clientId ?? quote.convertedClientId;

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
      deposit: quote.depositCents != null ? (quote.depositCents / 100).toFixed(2) : "",
      lines: lines.map((l) => ({
        key: l.id,
        description: l.description,
        quantity: String(l.quantity),
        price: (l.unit_amount_cents / 100).toFixed(2),
        recurring: l.recurring,
      })),
    };
    return (
      <>
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
      </>
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
    <>
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
        {quote.depositCents != null && (
          <p className="text-sm text-muted-foreground">
            Deposit{" "}
            <span className="font-medium tabular-nums text-foreground">
              {formatQuoteMoney(quote.depositCents)}
            </span>
            {" · "}
            {quote.depositInvoice
              ? quote.depositInvoice.status === "paid"
                ? "paid, on their account as credit"
                : quote.depositInvoice.status === "void"
                  ? "invoice voided"
                  : "invoiced, not paid yet"
              : quote.status !== "accepted"
                ? "asked for when they accept"
                : billTo
                  ? "not invoiced yet"
                  : "invoiced when you convert them to a client"}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          {target.kind !== "not-ready" && (
            <Button type="button" disabled={busy} onClick={convert}>
              <Check className="mr-1 h-4 w-4 shrink-0" />
              {target.kind === "client" ? "Convert to work" : "Convert to client"}
            </Button>
          )}
          {quote.status === "accepted" &&
            oneTimeCents > 0 &&
            billTo &&
            (quote.oneTimeInvoiceId ? (
              <Button asChild variant="outline">
                <Link to="/invoices/$invoiceId" params={{ invoiceId: quote.oneTimeInvoiceId }}>
                  Open one-time invoice
                </Link>
              </Button>
            ) : (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  if (
                    await confirm({
                      title: `Invoice ${formatQuoteMoney(oneTimeCents)} of one-time charges?`,
                      description: `An open invoice to ${quote.recipientName} for the lines on ${quote.label} that are not per visit. If they pay by autopay, it will be charged. Do this once the work is done.${quote.depositCents != null ? " A paid deposit comes off it as account credit." : ""}`,
                      confirmLabel: "Create invoice",
                    })
                  )
                    invoiceM.mutate();
                }}
              >
                {invoiceM.isPending
                  ? "Invoicing…"
                  : `Invoice one-time charges · ${formatQuoteMoney(oneTimeCents)}`}
              </Button>
            ))}
          {quote.status === "accepted" &&
            quote.depositCents != null &&
            (quote.depositInvoice ? (
              <>
                <Button asChild variant="outline">
                  <Link to="/invoices/$invoiceId" params={{ invoiceId: quote.depositInvoice.id }}>
                    Open deposit invoice
                  </Link>
                </Button>
                {quote.depositInvoice.status === "open" && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={busy}
                    onClick={() => sendDepositM.mutate(quote.depositInvoice!.id)}
                  >
                    <Send className="mr-1 h-4 w-4 shrink-0" />
                    {sendDepositM.isPending ? "Sending…" : "Email deposit invoice"}
                  </Button>
                )}
              </>
            ) : billTo ? (
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={() => depositM.mutate()}
              >
                {depositM.isPending
                  ? "Making…"
                  : `Make deposit invoice · ${formatQuoteMoney(quote.depositCents)}`}
              </Button>
            ) : null)}
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
          <DownloadPdfButton
            load={() => pdfFn({ data: { quoteId: quote.id } })}
            nativeUrl={
              quote.publicToken ? appUrl(`/api/public/quote-pdf?token=${quote.publicToken}`) : null
            }
          />
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
                      "The client's link will show the quote as expired, and it can no longer be accepted.",
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
        What the client sees
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
    </>
  );
}
