// Writing a quote: who it is for, the lines, a note, and how long it is good
// for. Used to start a quote (/quotes/new) and to keep editing a draft
// (/quotes/:id while it is still a draft). A sent quote is never edited: the
// database refuses it, and this form is not drawn for one.
//
// Every line is a small card rather than a table row. The four fields a line
// needs (description, quantity, price, per-visit) do not fit across a 320px
// phone, and a table that scrolls sideways under a thumb while you type into
// it is worse than one that stacks.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupSegment } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { listClients } from "@/lib/clients.functions";
import { saveQuoteDraft, sendQuote } from "@/lib/quotes.functions";
import { getFirstCleanupPricing } from "@/lib/first-cleanup.functions";
import { LAST_CLEANED_QUESTION, firstCleanupQuoteLine } from "@/lib/first-cleanup";
import {
  QUOTE_LIMITS,
  RECURRING_LABEL,
  formatQuoteMoney,
  lineAmountCents,
  parseMoneyToCents,
  parseQuantity,
  quoteTotals,
  sendResultMessage,
} from "@/lib/quotes";

export type EditorLine = {
  key: string;
  description: string;
  quantity: string;
  price: string;
  recurring: boolean;
};

export type QuoteEditorValues = {
  mode: "client" | "prospect";
  clientId: string;
  prospectName: string;
  prospectEmail: string;
  prospectPhone: string;
  leadId: string | null;
  title: string;
  message: string;
  validUntil: string;
  /** Asked for on accepting, as typed ("150" or "150.00"). Empty is none. */
  deposit: string;
  lines: EditorLine[];
};

let lineSeq = 0;
export function blankEditorLine(recurring = false): EditorLine {
  lineSeq += 1;
  return { key: `line-${lineSeq}`, description: "", quantity: "1", price: "", recurring };
}

export function QuoteEditor({
  initial,
  quoteId,
  today,
  leadName,
  onSaved,
}: {
  initial: QuoteEditorValues;
  /** Present when editing a draft that already exists. */
  quoteId?: string;
  /** The org's today, the earliest valid-until. */
  today: string;
  /** Shown when the quote was started from a lead. */
  leadName?: string | null;
  onSaved: (id: string) => void;
}) {
  const qc = useQueryClient();
  const clientsFn = useServerFn(listClients);
  const saveFn = useServerFn(saveQuoteDraft);
  const sendFn = useServerFn(sendQuote);
  const [v, setV] = useState<QuoteEditorValues>(initial);
  const [attempted, setAttempted] = useState(false);
  const set = <K extends keyof QuoteEditorValues>(k: K, val: QuoteEditorValues[K]) =>
    setV((s) => ({ ...s, [k]: val }));
  const setLine = (key: string, patch: Partial<EditorLine>) =>
    setV((s) => ({ ...s, lines: s.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) }));

  // "Add first cleanup": one one-time line, priced from the owner's
  // first-cleanup settings, which the person writing the quote can still
  // edit like any other line. Hidden when the owner has pricing off.
  const firstCleanupFn = useServerFn(getFirstCleanupPricing);
  const firstCleanupQ = useQuery({
    queryKey: ["first-cleanup-pricing"],
    queryFn: () => firstCleanupFn(),
    staleTime: 60_000,
  });
  const fcPricing = firstCleanupQ.data?.pricing ?? null;
  const fcZones = (firstCleanupQ.data?.zones ?? []).filter((z) => z.initialCleanupCents > 0);
  const [fcOpen, setFcOpen] = useState(false);
  // A tier id in tiered mode; a zone id in flat mode.
  const [fcChoice, setFcChoice] = useState("");
  const [fcDogs, setFcDogs] = useState("1");
  const fcLine =
    fcPricing && fcChoice
      ? firstCleanupQuoteLine(fcPricing, {
          tierId: fcPricing.mode === "by_last_cleaned" ? fcChoice : null,
          zoneFlatCents: fcZones.find((z) => z.id === fcChoice)?.initialCleanupCents ?? null,
          dogCount: Math.max(1, Math.min(20, parseInt(fcDogs, 10) || 1)),
        })
      : null;
  const addFirstCleanup = () => {
    if (!fcLine) return;
    setV((s) => {
      const line = { ...blankEditorLine(false), ...fcLine };
      // The editor opens on one blank line; fill that rather than leaving it
      // above the new one as a line that fails validation.
      const onlyBlank =
        s.lines.length === 1 && !s.lines[0].description.trim() && !s.lines[0].price.trim();
      return { ...s, lines: onlyBlank ? [line] : [...s.lines, line] };
    });
    setFcOpen(false);
    setFcChoice("");
  };

  const clientsQ = useQuery({
    queryKey: ["clients", "picker"],
    queryFn: () => clientsFn(),
    staleTime: 60_000,
  });
  const clients: Array<{ id: string; display_name: string; active: boolean | null }> =
    (clientsQ.data as any)?.clients ?? [];

  // Each line parsed once, for the totals, the per-line total and the errors.
  const parsed = useMemo(
    () =>
      v.lines.map((l) => {
        const quantity = parseQuantity(l.quantity);
        const unit = parseMoneyToCents(l.price);
        const description = l.description.trim();
        return {
          key: l.key,
          description,
          quantity,
          unit,
          recurring: l.recurring,
          amount: quantity != null && unit != null ? lineAmountCents(quantity, unit) : null,
          ok: !!description && quantity != null && unit != null,
        };
      }),
    [v.lines],
  );
  const totals = quoteTotals(
    parsed
      .filter((p) => p.amount != null)
      .map((p) => ({ amount_cents: p.amount as number, recurring: p.recurring })),
  );

  const recipientOk = v.mode === "client" ? !!v.clientId : v.prospectName.trim().length > 0;
  const emailOk =
    v.mode === "client" || !v.prospectEmail.trim() || /^\S+@\S+\.\S+$/.test(v.prospectEmail.trim());
  const dateOk = !v.validUntil || v.validUntil >= today;
  const linesOk = parsed.length > 0 && parsed.every((p) => p.ok);
  const depositCents = v.deposit.trim() ? parseMoneyToCents(v.deposit) : null;
  const depositOk =
    !v.deposit.trim() ||
    (depositCents != null &&
      depositCents >= QUOTE_LIMITS.minDepositCents &&
      depositCents <= QUOTE_LIMITS.maxDepositCents);
  const valid = recipientOk && emailOk && dateOk && linesOk && depositOk;

  const payload = () => ({
    id: quoteId,
    clientId: v.mode === "client" ? v.clientId : null,
    prospect:
      v.mode === "prospect"
        ? {
            name: v.prospectName.trim(),
            email: v.prospectEmail.trim(),
            phone: v.prospectPhone.trim(),
          }
        : null,
    leadId: v.leadId,
    title: v.title.trim(),
    message: v.message,
    validUntil: v.validUntil || null,
    depositCents: v.deposit.trim() ? depositCents : null,
    lines: parsed.map((p) => ({
      description: p.description,
      quantity: p.quantity as number,
      unitAmountCents: p.unit as number,
      recurring: p.recurring,
    })),
  });

  const saveM = useMutation({
    mutationFn: async (andSend: boolean) => {
      const { id } = await saveFn({ data: payload() });
      if (!andSend) return { id, sent: null };
      const sent = await sendFn({ data: { id } });
      return { id, sent };
    },
    onSuccess: ({ id, sent }) => {
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["quote", id] });
      if (sent) {
        const m = sendResultMessage(sent);
        if (m.ok) toast.success(m.text);
        else toast.warning(m.text, { duration: 10_000 });
      } else {
        toast.success("Draft saved");
      }
      onSaved(id);
    },
    onError: (e) => toast.error((e as Error).message),
  });

  const submit = (andSend: boolean) => {
    if (!valid) {
      setAttempted(true);
      return;
    }
    saveM.mutate(andSend);
  };

  return (
    <div className="space-y-4">
      {leadName && (
        <p className="break-words rounded-md border bg-primary/5 p-3 text-sm">
          Started from the lead <strong>{leadName}</strong>.
        </p>
      )}

      <Card className="space-y-5 p-4 sm:p-6">
        <div className="space-y-2">
          <Label id="quote-recipient-label">Quote for</Label>
          <RadioGroup
            aria-labelledby="quote-recipient-label"
            value={v.mode}
            onValueChange={(m) => set("mode", m as QuoteEditorValues["mode"])}
            className="flex gap-2"
          >
            <RadioGroupSegment value="client">A client</RadioGroupSegment>
            <RadioGroupSegment value="prospect">Someone new</RadioGroupSegment>
          </RadioGroup>
        </div>

        {v.mode === "client" ? (
          <div className="space-y-2">
            <Label htmlFor="quote-client">Client</Label>
            <select
              id="quote-client"
              className="h-10 w-full rounded-md border bg-background px-3 text-sm touch:min-h-11"
              value={v.clientId}
              onChange={(e) => set("clientId", e.target.value)}
              aria-invalid={attempted && !v.clientId ? true : undefined}
            >
              <option value="">
                {clientsQ.isLoading ? "Loading clients…" : "Select a client…"}
              </option>
              {clients
                .filter((c) => c.active !== false || c.id === v.clientId)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.display_name}
                  </option>
                ))}
            </select>
            {attempted && !v.clientId && (
              <p className="text-xs text-destructive">Choose who the quote is for.</p>
            )}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="quote-prospect-name">Name</Label>
              <Input
                id="quote-prospect-name"
                value={v.prospectName}
                maxLength={200}
                onChange={(e) => set("prospectName", e.target.value)}
                placeholder="Oakwood Terrace HOA"
                aria-invalid={attempted && !v.prospectName.trim() ? true : undefined}
              />
              {attempted && !v.prospectName.trim() && (
                <p className="text-xs text-destructive">Type who the quote is for.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="quote-prospect-email">Email</Label>
              <Input
                id="quote-prospect-email"
                type="email"
                value={v.prospectEmail}
                maxLength={320}
                onChange={(e) => set("prospectEmail", e.target.value)}
                aria-invalid={attempted && !emailOk ? true : undefined}
              />
              {attempted && !emailOk && (
                <p className="text-xs text-destructive">That email address does not look right.</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="quote-prospect-phone">Phone</Label>
              <Input
                id="quote-prospect-phone"
                type="tel"
                value={v.prospectPhone}
                maxLength={40}
                onChange={(e) => set("prospectPhone", e.target.value)}
              />
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">
              With no email, Send marks the quote sent and you share the link yourself.
            </p>
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="quote-title">What it is for (optional)</Label>
            <Input
              id="quote-title"
              value={v.title}
              maxLength={QUOTE_LIMITS.title}
              onChange={(e) => set("title", e.target.value)}
              placeholder="Weekly yard service"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="quote-valid-until">Valid until</Label>
            <Input
              id="quote-valid-until"
              type="date"
              min={today}
              value={v.validUntil}
              onChange={(e) => set("validUntil", e.target.value)}
              aria-invalid={attempted && !dateOk ? true : undefined}
            />
            {attempted && !dateOk && (
              <p className="text-xs text-destructive">Pick today or a later day.</p>
            )}
          </div>
        </div>
      </Card>

      <Card className="space-y-3 p-4 sm:p-6">
        <div>
          <h2 className="text-base font-medium">Lines</h2>
          <p className="text-sm text-muted-foreground">
            Tick {RECURRING_LABEL} for a price charged on every visit. Leave it off for a one-time
            charge, like an initial cleanup.
          </p>
        </div>
        {v.lines.map((l, i) => {
          const p = parsed[i];
          return (
            <div key={l.key} className="space-y-2 rounded-md border p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1 space-y-1">
                  <Label htmlFor={`${l.key}-desc`} className="text-xs">
                    Description
                  </Label>
                  <Input
                    id={`${l.key}-desc`}
                    value={l.description}
                    maxLength={QUOTE_LIMITS.description}
                    onChange={(e) => setLine(l.key, { description: e.target.value })}
                    placeholder={l.recurring ? "Weekly visit, two dogs" : "Initial cleanup"}
                    aria-invalid={attempted && !p.description ? true : undefined}
                  />
                </div>
                {v.lines.length > 1 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="mt-5 shrink-0"
                    aria-label={`Remove line ${i + 1}`}
                    onClick={() =>
                      set(
                        "lines",
                        v.lines.filter((x) => x.key !== l.key),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4 shrink-0" />
                  </Button>
                )}
              </div>
              <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
                <div className="w-20 space-y-1">
                  <Label htmlFor={`${l.key}-qty`} className="text-xs">
                    Qty
                  </Label>
                  <Input
                    id={`${l.key}-qty`}
                    inputMode="decimal"
                    value={l.quantity}
                    onChange={(e) => setLine(l.key, { quantity: e.target.value })}
                    aria-invalid={attempted && p.quantity == null ? true : undefined}
                  />
                </div>
                <div className="min-w-[7rem] flex-1 space-y-1">
                  <Label htmlFor={`${l.key}-price`} className="text-xs">
                    Price each ($)
                  </Label>
                  <Input
                    id={`${l.key}-price`}
                    inputMode="decimal"
                    value={l.price}
                    placeholder="0.00"
                    onChange={(e) => setLine(l.key, { price: e.target.value })}
                    aria-invalid={attempted && p.unit == null ? true : undefined}
                  />
                </div>
                <label className="flex min-h-11 items-center gap-2 text-sm">
                  <Checkbox
                    checked={l.recurring}
                    onCheckedChange={(c) => setLine(l.key, { recurring: c === true })}
                  />
                  <span>{RECURRING_LABEL}</span>
                </label>
                <p className="ml-auto shrink-0 pb-2 text-sm font-medium tabular-nums">
                  {p.amount != null ? formatQuoteMoney(p.amount) : "–"}
                </p>
              </div>
              {attempted && !p.ok && (
                <p className="text-xs text-destructive">
                  A line needs a description, a quantity above zero and a price.
                </p>
              )}
            </div>
          );
        })}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={v.lines.length >= QUOTE_LIMITS.maxLines}
            onClick={() => set("lines", [...v.lines, blankEditorLine(false)])}
          >
            <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> One-time line
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={v.lines.length >= QUOTE_LIMITS.maxLines}
            onClick={() => set("lines", [...v.lines, blankEditorLine(true)])}
          >
            <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Per-visit line
          </Button>
          {fcPricing && fcPricing.mode !== "off" && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-expanded={fcOpen}
              disabled={v.lines.length >= QUOTE_LIMITS.maxLines}
              onClick={() => setFcOpen((o) => !o)}
            >
              <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Add first cleanup
            </Button>
          )}
        </div>
        {fcOpen && fcPricing && fcPricing.mode !== "off" && (
          <div className="space-y-3 rounded-md border bg-muted/20 p-3">
            {fcPricing.mode === "flat" && fcZones.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Every zone&apos;s first-cleanup fee is $0. Set one on the Zones page, or add a
                one-time line by hand.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
                <div className="min-w-0 space-y-1">
                  <Label htmlFor="quote-fc-choice" className="text-xs">
                    {fcPricing.mode === "by_last_cleaned"
                      ? LAST_CLEANED_QUESTION.replace("your yard", "the yard")
                      : "Zone"}
                  </Label>
                  <select
                    id="quote-fc-choice"
                    value={fcChoice}
                    onChange={(e) => setFcChoice(e.target.value)}
                    className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm touch:min-h-11"
                  >
                    <option value="">Pick one</option>
                    {fcPricing.mode === "by_last_cleaned"
                      ? fcPricing.tiers.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))
                      : fcZones.map((z) => (
                          <option key={z.id} value={z.id}>
                            {z.name}
                          </option>
                        ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="quote-fc-dogs" className="text-xs">
                    Dogs
                  </Label>
                  <Input
                    id="quote-fc-dogs"
                    type="number"
                    min={1}
                    max={20}
                    value={fcDogs}
                    onChange={(e) => setFcDogs(e.target.value)}
                  />
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" disabled={!fcLine} onClick={addFirstCleanup}>
                {fcLine ? `Add first cleanup, $${fcLine.price}` : "Add first cleanup"}
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setFcOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        <dl className="space-y-1 border-t pt-3 text-sm">
          <div className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-muted-foreground">One-time total</dt>
            <dd className="shrink-0 font-semibold tabular-nums">
              {formatQuoteMoney(totals.oneTimeCents)}
            </dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="min-w-0 text-muted-foreground">Recurring, {RECURRING_LABEL}</dt>
            <dd className="shrink-0 font-semibold tabular-nums">
              {formatQuoteMoney(totals.recurringCents)}
            </dd>
          </div>
        </dl>
      </Card>

      <Card className="space-y-2 p-4 sm:p-6">
        <Label htmlFor="quote-deposit">Deposit when they accept (optional)</Label>
        <Input
          id="quote-deposit"
          inputMode="decimal"
          className="sm:max-w-48"
          value={v.deposit}
          onChange={(e) => set("deposit", e.target.value)}
          placeholder="0.00"
          aria-invalid={attempted && !depositOk ? true : undefined}
          aria-describedby="quote-deposit-help"
        />
        <p id="quote-deposit-help" className="text-sm text-muted-foreground">
          The customer is asked to pay it right after accepting. It goes on their account as credit
          and comes off their first invoices. A quote to a prospect gets its deposit invoice when
          you convert it to a client.
        </p>
        {attempted && !depositOk && (
          <p className="text-xs text-destructive">A deposit is between $1.00 and $10,000.</p>
        )}
      </Card>

      <Card className="space-y-2 p-4 sm:p-6">
        <Label htmlFor="quote-message">Note to the customer (optional)</Label>
        <Textarea
          id="quote-message"
          rows={4}
          maxLength={QUOTE_LIMITS.message}
          value={v.message}
          onChange={(e) => set("message", e.target.value)}
          placeholder="Thanks for walking the yard with me today. This covers the back lawn and the side run."
        />
      </Card>

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button
          type="button"
          variant="outline"
          disabled={saveM.isPending}
          onClick={() => submit(false)}
        >
          {saveM.isPending && saveM.variables === false ? "Saving…" : "Save draft"}
        </Button>
        <Button type="button" disabled={saveM.isPending} onClick={() => submit(true)}>
          {saveM.isPending && saveM.variables === true ? "Sending…" : "Save and send"}
        </Button>
      </div>
      {attempted && !valid && (
        <p role="alert" className="text-right text-sm text-destructive">
          Fix the highlighted fields first.
        </p>
      )}
    </div>
  );
}
