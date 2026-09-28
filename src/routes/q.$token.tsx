// Public quote page: /q/{token}. No account and no password: the unguessable
// quotes.public_token is the capability, the same model as the invoice pay
// link (/pay/i/{token}), which this page is modelled on. The customer reads
// the quote and accepts it by typing their full name, which is the
// signature, or declines it with an optional reason.
//
// Whatever they answered is what the page shows from then on, on a reload or
// a second device, because the answer is read back from the database rather
// than remembered by the browser. A second tap on Accept returns the first
// acceptance (public_quote_respond is idempotent), so a double tap on a slow
// connection is one signature, not an error.
//
// Opened from a text on a phone essentially always: every row here stacks at
// 320px, and every control is on the 44px floor through ui/button and
// ui/input.
import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CheckCircle2, Clock, Loader2, Mail, Phone, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { QuoteDocument } from "@/components/quotes/QuoteDocument";
import { getPublicQuote, respondToPublicQuote } from "@/lib/quotes.functions";
import { QUOTE_LIMITS, formatQuoteDay, isUsableSignature } from "@/lib/quotes";
import { orgLocalDay } from "@/lib/org-day";

export const Route = createFileRoute("/q/$token")({
  head: () => ({ meta: [{ title: "Your quote" }] }),
  component: PublicQuotePage,
});

type Loaded = Extract<Awaited<ReturnType<typeof getPublicQuote>>, { found: true }>;

function PublicQuotePage() {
  const { token } = Route.useParams();
  const getFn = useServerFn(getPublicQuote);
  const q = useQuery({
    queryKey: ["public-quote", token],
    queryFn: () => getFn({ data: { token } }),
    retry: 1,
  });

  if (q.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin shrink-0" /> Loading quote…
      </div>
    );
  }
  if (q.isError) {
    return (
      <div className="mx-auto max-w-lg space-y-2 p-6 text-center">
        <h1 className="text-lg font-semibold">This quote could not be loaded</h1>
        <p className="text-sm text-muted-foreground">Please try again in a moment.</p>
        <Button variant="outline" onClick={() => q.refetch()}>
          Try again
        </Button>
      </div>
    );
  }
  if (!q.data || !q.data.found) {
    return (
      <div className="mx-auto max-w-lg space-y-2 p-6 text-center">
        <h1 className="text-lg font-semibold">This quote link isn't valid</h1>
        <p className="text-sm text-muted-foreground">
          The link may have been mistyped, or the quote is no longer available. Please contact the
          business that sent it.
        </p>
      </div>
    );
  }

  const data = q.data;
  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">
      <QuoteDocument
        orgName={data.org.name}
        label={data.quote.label}
        status={data.quote.status}
        title={data.quote.title}
        recipientName={data.quote.recipientName}
        validUntil={data.quote.validUntil}
        message={data.quote.message}
        lines={data.lines}
        currency={data.quote.currency}
      />
      <Answer token={token} data={data} />
      <Contact data={data} />
    </div>
  );
}

/** The day an answer happened, on the business's calendar. */
function answeredOn(ts: string | null, tz: string | null): string {
  if (!ts) return "";
  return formatQuoteDay(orgLocalDay(ts, tz ?? undefined));
}

function Answer({ token, data }: { token: string; data: Loaded }) {
  const qc = useQueryClient();
  const respondFn = useServerFn(respondToPublicQuote);
  const [name, setName] = useState("");
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  const respondM = useMutation({
    mutationFn: (accept: boolean) =>
      respondFn({
        data: accept
          ? { token, accept, name }
          : { token, accept, reason: reason.trim() || undefined },
      }),
    onSuccess: () => {
      setError(null);
      // Read the answer back rather than assume it: what the page shows is
      // what the database holds, which is also what a reload will show.
      qc.invalidateQueries({ queryKey: ["public-quote", token] });
    },
    onError: (e) => {
      setError((e as Error).message);
      // A refusal (expired, already answered elsewhere) means the page is out
      // of date; show the quote as it now stands.
      qc.invalidateQueries({ queryKey: ["public-quote", token] });
    },
  });

  const { status } = data.quote;
  const tz = data.org.timezone;

  if (status === "accepted") {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-xl border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-300"
      >
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">You accepted this quote.</p>
          <p className="break-words">
            Signed by {data.quote.acceptedName} on {answeredOn(data.quote.acceptedAt, tz)}.{" "}
            {data.org.name} has been told and will be in touch to get you scheduled.
          </p>
        </div>
      </div>
    );
  }

  if (status === "declined") {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-xl border bg-muted/40 p-4 text-sm"
      >
        <XCircle className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">
            You declined this quote on {answeredOn(data.quote.declinedAt, tz)}.
          </p>
          {data.quote.declineReason && (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              Your reason: {data.quote.declineReason}
            </p>
          )}
          <p className="text-muted-foreground">
            Changed your mind? Contact {data.org.name} and they can send you a new quote.
          </p>
        </div>
      </div>
    );
  }

  if (status === "expired") {
    return (
      <div
        role="status"
        className="flex items-start gap-3 rounded-xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-900 dark:text-amber-300"
      >
        <Clock className="mt-0.5 h-5 w-5 shrink-0" />
        <div className="min-w-0 space-y-1">
          <p className="font-medium">This quote has expired.</p>
          <p>It can no longer be accepted. Contact {data.org.name} for an updated quote.</p>
        </div>
      </div>
    );
  }

  const canAccept = isUsableSignature(name);
  return (
    <div className="space-y-4 rounded-xl border bg-card p-4 shadow-sm sm:p-6">
      {error && (
        <p
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
        >
          {error}
        </p>
      )}
      {!declining ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (canAccept && !respondM.isPending) respondM.mutate(true);
          }}
        >
          <h2 className="text-base font-semibold">Accept this quote</h2>
          <div className="space-y-1.5">
            <Label htmlFor="quote-signature">Type your full name</Label>
            <Input
              id="quote-signature"
              autoComplete="name"
              value={name}
              maxLength={QUOTE_LIMITS.signatureMax}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
            />
            <p className="text-xs text-muted-foreground">
              Typing your name and pressing Accept is your signature agreeing to this quote.
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" className="sm:flex-1" disabled={!canAccept || respondM.isPending}>
              {respondM.isPending && respondM.variables === true ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin shrink-0" /> Accepting…
                </>
              ) : (
                "Accept quote"
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={respondM.isPending}
              onClick={() => {
                setError(null);
                setDeclining(true);
              }}
            >
              Decline
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!respondM.isPending) respondM.mutate(false);
          }}
        >
          <h2 className="text-base font-semibold">Decline this quote</h2>
          <div className="space-y-1.5">
            <Label htmlFor="quote-decline-reason">Reason (optional)</Label>
            <Textarea
              id="quote-decline-reason"
              rows={3}
              maxLength={QUOTE_LIMITS.declineReason}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Anything that would help them, like the price or the timing"
            />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="submit"
              variant="destructive"
              className="sm:flex-1"
              disabled={respondM.isPending}
            >
              {respondM.isPending && respondM.variables === false ? "Declining…" : "Decline quote"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={respondM.isPending}
              onClick={() => setDeclining(false)}
            >
              Back
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function Contact({ data }: { data: Loaded }) {
  const { phone, email, name } = data.org;
  if (!phone && !email) return null;
  return (
    <div className="space-y-2 pb-6 text-sm">
      <p className="text-muted-foreground">Questions about this quote? Contact {name}.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {phone && (
          <Button asChild variant="outline">
            <a href={`tel:${phone}`}>
              <Phone className="mr-1 h-4 w-4 shrink-0" /> {phone}
            </a>
          </Button>
        )}
        {email && (
          <Button asChild variant="outline" className="max-w-full">
            <a href={`mailto:${email}`} className="min-w-0">
              <Mail className="mr-1 h-4 w-4 shrink-0" />
              <span className="truncate">{email}</span>
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
