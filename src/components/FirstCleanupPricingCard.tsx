// First-cleanup pricing, on the Zones page because that is where prices live.
//
// Read-only summary first, edited behind a button: most visits to /zones are
// about the zones, and a form with eight price boxes open above them would be
// the first thing on the page every time. The summary is also what a person
// without manage_pricing sees, and it has to answer "what does a new customer
// pay for the first visit?" on its own.
//
// The layout rules this has to keep at 320px: a tier row is a label that
// takes whatever is left and a price and a remove button that do not give up
// their width, and when that does not fit on one line the row WRAPS rather
// than squeezing the label to nothing.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupSegment } from "@/components/ui/radio-group";
import { getFirstCleanupPricing, setFirstCleanupPricing } from "@/lib/first-cleanup.functions";
import {
  FIRST_CLEANUP_MODE_LABEL,
  LAST_CLEANED_QUESTION,
  MAX_TIERS,
  MAX_TIER_LABEL,
  SUGGESTED_TIER_LABELS,
  firstCleanupPricingProblem,
  newTierId,
  type FirstCleanupMode,
  type FirstCleanupPricing,
} from "@/lib/first-cleanup";
import { parseMoneyToCents } from "@/lib/quotes";

const money = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

type DraftTier = { id: string; label: string; price: string };
type Draft = { mode: FirstCleanupMode; tiers: DraftTier[]; perExtraDog: string };

const toDraft = (p: FirstCleanupPricing): Draft => ({
  mode: p.mode,
  tiers: p.tiers.map((t) => ({ id: t.id, label: t.label, price: (t.priceCents / 100).toFixed(2) })),
  perExtraDog: p.perExtraDogCents > 0 ? (p.perExtraDogCents / 100).toFixed(2) : "",
});

/** The draft as the server wants it, or the sentence that says why not. */
function fromDraft(d: Draft): { pricing: FirstCleanupPricing } | { problem: string } {
  // Tiers are kept while another mode is picked, so switching back later
  // does not throw away what the owner typed. They are only REQUIRED to be
  // complete in tiered mode; elsewhere an unfinished one is simply not kept.
  const tiered = d.mode === "by_last_cleaned";
  const tiers = [];
  for (const t of d.tiers) {
    const cents = parseMoneyToCents(t.price);
    if (cents == null || !t.label.trim()) {
      if (!tiered) continue;
      if (!t.label.trim()) return { problem: "Every answer needs a label." };
      return { problem: `Give "${t.label.trim()}" a price, like 75 or 75.00.` };
    }
    tiers.push({ id: t.id, label: t.label.trim(), priceCents: cents });
  }
  const perExtraDogCents = d.perExtraDog.trim() ? parseMoneyToCents(d.perExtraDog) : 0;
  if (perExtraDogCents == null) return { problem: "The extra-dog amount is not a price." };
  const pricing: FirstCleanupPricing = { mode: d.mode, tiers, perExtraDogCents };
  const problem = firstCleanupPricingProblem(pricing);
  return problem ? { problem } : { pricing };
}

export function FirstCleanupPricingCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const getFn = useServerFn(getFirstCleanupPricing);
  const setFn = useServerFn(setFirstCleanupPricing);
  const q = useQuery({ queryKey: ["first-cleanup-pricing"], queryFn: () => getFn() });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [attempted, setAttempted] = useState(false);

  const saveM = useMutation({
    mutationFn: (pricing: FirstCleanupPricing) => setFn({ data: pricing }),
    onSuccess: () => {
      toast.success("First-cleanup pricing saved.");
      setDraft(null);
      setAttempted(false);
      qc.invalidateQueries({ queryKey: ["first-cleanup-pricing"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const checked = useMemo(() => (draft ? fromDraft(draft) : null), [draft]);

  if (!q.data) return null;
  const { pricing, zones } = q.data;
  const pricedZones = zones.filter((z) => z.initialCleanupCents > 0);

  const setTier = (id: string, patch: Partial<DraftTier>) =>
    setDraft((d) => d && { ...d, tiers: d.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });

  return (
    <Card className="space-y-4 p-4 sm:p-6">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">First cleanup</h2>
        <p className="text-sm text-muted-foreground">
          What a new customer pays, once, for the first visit to a yard. Online signup charges it,
          and the new-client wizard and quotes offer it with the price filled in.
        </p>
      </div>

      {!draft ? (
        <div className="space-y-3">
          <p className="text-sm">
            <span className="font-medium">{FIRST_CLEANUP_MODE_LABEL[pricing.mode]}.</span>{" "}
            {pricing.mode === "off" && "New customers are not charged for a first cleanup."}
            {pricing.mode === "flat" &&
              (pricedZones.length
                ? "Each zone's Initial cleanup fee, set on the zone."
                : "Each zone's Initial cleanup fee, and every zone's is $0, so nothing is charged yet.")}
            {pricing.mode === "by_last_cleaned" && `Customers answer "${LAST_CLEANED_QUESTION}"`}
          </p>
          {pricing.mode === "flat" && pricedZones.length > 0 && (
            <ul className="space-y-1 text-sm">
              {pricedZones.map((z) => (
                <li key={z.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words text-muted-foreground">{z.name}</span>
                  <span className="shrink-0 tabular-nums">{money(z.initialCleanupCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {pricing.mode === "by_last_cleaned" && (
            <ul className="space-y-1 text-sm">
              {pricing.tiers.map((t) => (
                <li key={t.id} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 break-words">{t.label}</span>
                  <span className="shrink-0 tabular-nums">{money(t.priceCents)}</span>
                </li>
              ))}
            </ul>
          )}
          {pricing.mode !== "off" && pricing.perExtraDogCents > 0 && (
            <p className="text-sm text-muted-foreground">
              Plus {money(pricing.perExtraDogCents)} for each dog after the first.
            </p>
          )}
          {canEdit && (
            <Button type="button" variant="outline" onClick={() => setDraft(toDraft(pricing))}>
              Edit first-cleanup pricing
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <RadioGroup
            value={draft.mode}
            onValueChange={(v) => {
              const mode = v as FirstCleanupMode;
              setDraft((d) =>
                d && {
                  ...d,
                  mode,
                  // Starting tiered from nothing: the four usual answers, with
                  // the prices left for the owner to fill in.
                  tiers:
                    mode === "by_last_cleaned" && d.tiers.length === 0
                      ? SUGGESTED_TIER_LABELS.map((t) => ({ id: t.id, label: t.label, price: "" }))
                      : d.tiers,
                },
              );
            }}
            aria-label="How the first cleanup is priced"
            className="flex flex-wrap gap-2"
          >
            <RadioGroupSegment value="off">Off</RadioGroupSegment>
            <RadioGroupSegment value="flat">Flat price</RadioGroupSegment>
            <RadioGroupSegment value="by_last_cleaned">By time since last cleaned</RadioGroupSegment>
          </RadioGroup>

          {draft.mode === "off" && (
            <p className="text-sm text-muted-foreground">
              No first-cleanup charge at signup, and nothing offered in the wizard or on quotes.
            </p>
          )}
          {draft.mode === "flat" && (
            <p className="text-sm text-muted-foreground">
              Each zone charges its own Initial cleanup fee. Change it by editing the zone below.
              {pricedZones.length === 0 && " Every zone's is $0 right now."}
            </p>
          )}

          {draft.mode === "by_last_cleaned" && (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Customers answer "{LAST_CLEANED_QUESTION}" and pay the price beside their answer, in
                every zone. Word the answers however you like.
              </p>
              {draft.tiers.map((t, i) => {
                const priceBad = attempted && parseMoneyToCents(t.price) == null;
                return (
                  <div key={t.id} className="flex flex-wrap items-end gap-2 rounded-md border p-3">
                    <div className="min-w-0 flex-1 basis-48 space-y-1">
                      <Label htmlFor={`fc-${t.id}-label`} className="text-xs">
                        Answer {i + 1}
                      </Label>
                      <Input
                        id={`fc-${t.id}-label`}
                        value={t.label}
                        maxLength={MAX_TIER_LABEL}
                        onChange={(e) => setTier(t.id, { label: e.target.value })}
                        aria-invalid={attempted && !t.label.trim() ? true : undefined}
                      />
                    </div>
                    <div className="w-28 shrink-0 space-y-1">
                      <Label htmlFor={`fc-${t.id}-price`} className="text-xs">
                        Price ($)
                      </Label>
                      <Input
                        id={`fc-${t.id}-price`}
                        inputMode="decimal"
                        placeholder="0.00"
                        value={t.price}
                        onChange={(e) => setTier(t.id, { price: e.target.value })}
                        aria-invalid={priceBad ? true : undefined}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="shrink-0"
                      aria-label={`Remove answer ${i + 1}`}
                      onClick={() =>
                        setDraft((d) => d && { ...d, tiers: d.tiers.filter((x) => x.id !== t.id) })
                      }
                    >
                      <Trash2 className="h-4 w-4 shrink-0" />
                    </Button>
                  </div>
                );
              })}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={draft.tiers.length >= MAX_TIERS}
                onClick={() =>
                  setDraft(
                    (d) => d && { ...d, tiers: [...d.tiers, { id: newTierId(), label: "", price: "" }] },
                  )
                }
              >
                <Plus className="mr-1 h-3.5 w-3.5 shrink-0" /> Add an answer
              </Button>
            </div>
          )}

          {draft.mode !== "off" && (
            <div className="max-w-xs space-y-1">
              <Label htmlFor="fc-extra-dog">Each dog after the first (optional, $)</Label>
              <Input
                id="fc-extra-dog"
                inputMode="decimal"
                placeholder="0.00"
                value={draft.perExtraDog}
                onChange={(e) => setDraft((d) => d && { ...d, perExtraDog: e.target.value })}
              />
              <p className="text-xs text-muted-foreground">
                Added to a first cleanup that costs something. A $0 first cleanup stays free.
              </p>
            </div>
          )}

          {attempted && checked && "problem" in checked && (
            <p role="alert" className="text-sm text-destructive">
              {checked.problem}
            </p>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button
              type="button"
              variant="outline"
              disabled={saveM.isPending}
              onClick={() => {
                setDraft(null);
                setAttempted(false);
              }}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={saveM.isPending}
              onClick={() => {
                setAttempted(true);
                if (checked && "pricing" in checked) saveM.mutate(checked.pricing);
              }}
            >
              {saveM.isPending ? "Saving…" : "Save first-cleanup pricing"}
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}
