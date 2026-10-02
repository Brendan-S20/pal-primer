// What a stop card says about the dogs, the yard, the stations and the money.
//
// Presentational: everything arrives as props and nothing here fetches or
// writes, so each piece renders in a test without a query client, and the
// rules behind them live in lib/stop-facts where they are tested on their own.
// The one write -- recording cash or a check -- is the card's, through the
// offline queue like Complete and Skip; CollectForm only collects the answer.

import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Banknote,
  ChevronDown,
  ChevronUp,
  CreditCard,
  Dog,
  FileText,
  Hourglass,
  LandPlot,
  Trash2,
} from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatDay } from "@/lib/format";
import {
  activeStations,
  areaParts,
  collectionAmountProblem,
  dogsLine,
  dueCents,
  formatMoney,
  outlinePath,
  parseDollars,
  paymentMode,
  type StopDog,
  type StopFacts,
  type StopStation,
} from "@/lib/stop-facts";
import type { PolygonGeoJSON } from "@/components/BoundarySketch";

/** Temperaments the app writes, worded by `dog.<temperament>`. Anything else
 *  is shown as stored. */
const DOG_TEMPERAMENTS = new Set(["friendly", "nervous", "aggressive", "unknown"]);

/**
 * The dogs on site, always said.
 *
 * Named chips when there are dog records (aggressive ones red: this is the
 * line that tells somebody what is behind the gate before they open it); the
 * count the subscription is priced on when there are none; and "No dogs on
 * file" when there is neither. It used to draw nothing at all without
 * records, which was most stops, so a tech could not tell "no dogs" from "we
 * don't know".
 */
export function DogsLine({ dogs, dogCount }: { dogs: unknown; dogCount?: number | null }) {
  const { t } = useTranslation();
  const line = dogsLine(dogs, dogCount);
  if (line.kind === "none") {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Dog className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{t("dogs.none")}</span>
      </div>
    );
  }
  if (line.kind === "count") {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-sm font-medium">
        <Dog className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0">{t("dogs.countOnly", { count: line.count })}</span>
      </div>
    );
  }
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <span className="text-sm font-medium">{t("dogs.named", { count: line.dogs.length })}</span>
      {line.dogs.map((d: StopDog, i: number) => {
        const aggressive = d?.temperament === "aggressive";
        return (
          <span
            key={d?.id ?? `${d?.name ?? ""}-${i}`}
            className={`inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-2xl border px-2.5 py-1 text-sm ${
              aggressive
                ? "border-destructive/60 bg-destructive/10 font-semibold text-destructive"
                : "border-border bg-muted/50 text-foreground/80"
            }`}
          >
            <Dog className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="sr-only">{t("dog.onSite")}</span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {d?.name || t("dog.fallbackName")}
            </span>
            {d?.temperament && (
              <span className="shrink-0 font-normal opacity-80">
                · {DOG_TEMPERAMENTS.has(d.temperament) ? t(`dog.${d.temperament}`) : d.temperament}
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** The shared boundary map, loaded only when somebody opens it. Leaflet today
 *  and Google once the maps move: either way a load is real weight, and once
 *  on Google it is a billed load, so a 30-stop day must not make 30 of them
 *  to draw cards nobody has opened. */
const BoundaryPreviewLazy = lazy(() =>
  import("@/components/BoundaryPreview").then((m) => ({ default: m.BoundaryPreview })),
);

/** "4,200 sq ft" / "1.25 acres", in the tech's numbers. */
export function areaText(t: TFunction, sqm: number | null | undefined, locale?: string) {
  const a = areaParts(sqm);
  if (!a) return null;
  const value = new Intl.NumberFormat(locale, {
    maximumFractionDigits: a.unit === "acres" ? 2 : 0,
  }).format(a.value);
  return t(`outline.area_${a.unit}`, { value });
}

/**
 * The yard's sketched outline: a small drawing of the shape on the card, and
 * the real map one tap away.
 *
 * The drawing is an SVG of the coordinates the card already has -- no tiles,
 * no map load, nothing billed -- so every card can carry one. The map is the
 * shared BoundaryPreview, mounted only inside the dialog the tap opens.
 */
export function YardOutline({
  boundary,
  areaSqm,
  title,
  locale,
}: {
  boundary: unknown;
  areaSqm?: number | null;
  /** The dialog's heading: the street, so it is clear which yard. */
  title: string;
  locale?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const path = outlinePath(boundary, 56);
  if (!path) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <LandPlot className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{t("outline.none")}</span>
      </div>
    );
  }
  const area = areaText(t, areaSqm, locale);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("outline.open")}
        className="mt-2.5 flex min-h-14 w-full min-w-0 items-center gap-3 rounded-lg border bg-background p-1.5 text-left transition-colors hover:bg-accent active:bg-accent"
      >
        <svg
          viewBox="0 0 56 56"
          className="h-14 w-14 shrink-0 rounded-md bg-emerald-600/5"
          aria-hidden="true"
        >
          <path
            d={path}
            className="fill-emerald-600/20 stroke-emerald-700 dark:stroke-emerald-400"
            strokeWidth={1.5}
            strokeLinejoin="round"
          />
        </svg>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {t("outline.heading")}
            {area ? <span className="font-normal text-muted-foreground"> · {area}</span> : null}
          </span>
          <span className="block text-xs text-muted-foreground">{t("outline.tapToOpen")}</span>
        </span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[92dvh] w-[96vw] max-w-3xl flex-col gap-3 p-4">
          <DialogTitle className="min-w-0 pr-10 text-base [overflow-wrap:anywhere]">
            {title}
            {area ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">{area}</span>
            ) : null}
          </DialogTitle>
          {open && (
            <Suspense
              fallback={
                <div className="grid h-[60dvh] place-items-center rounded-md border bg-muted/30 text-sm text-muted-foreground">
                  {t("outline.loading")}
                </div>
              }
            >
              <BoundaryPreviewLazy
                boundary={boundary as PolygonGeoJSON}
                height={Math.round(
                  Math.min(520, (typeof window !== "undefined" ? window.innerHeight : 800) * 0.6),
                )}
                title={title}
              />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** "Station 3 · Pool gate", in the tech's language -- the rule the office's
 *  stationDisplayName uses, worded by `stationsSummary.*`. */
export function stationName(t: TFunction, s: StopStation): string {
  const num =
    typeof s.station_number === "number" && s.station_number > 0 ? s.station_number : null;
  const label = s.label?.trim() || null;
  if (num && label) return t("stationsSummary.numberedLabel", { number: num, label });
  if (num) return t("stationsSummary.numbered", { number: num });
  return label ?? t("stationsSummary.unnamed");
}

/** How many stations show before "Show all". Four lines is a glance; a
 *  twenty-bin complex is a list the Stations panel is for. */
const STATIONS_SHOWN = 4;

/**
 * A commercial or multi-unit stop's waste stations: how many, which, where,
 * and when each was last serviced -- the facts the office's stations panel
 * shows, so the tech and the office are looking at the same list. Logging a
 * station is still the Stations panel's job; this is what the tech reads
 * walking up.
 */
export function StationsSummary({ stations, locale }: { stations: unknown; locale?: string }) {
  const { t } = useTranslation();
  const [all, setAll] = useState(false);
  const list = activeStations(stations);
  if (list.length === 0) return null;
  const shown = all ? list : list.slice(0, STATIONS_SHOWN);
  return (
    <div className="mt-2.5 rounded-lg border bg-muted/30 p-2.5">
      <div className="flex items-center gap-1.5 text-sm font-semibold">
        <Trash2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0">{t("stationsSummary.count", { count: list.length })}</span>
      </div>
      <ul className="mt-1.5 space-y-1.5">
        {shown.map((s) => (
          <li key={s.id} className="min-w-0 text-sm">
            <div className="font-medium [overflow-wrap:anywhere]">{stationName(t, s)}</div>
            <div className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {s.location_description ? `${s.location_description} · ` : ""}
              {s.last_serviced_on
                ? t("stationsSummary.lastServiced", { day: formatDay(s.last_serviced_on, locale) })
                : t("stationsSummary.notYet")}
            </div>
          </li>
        ))}
      </ul>
      {list.length > STATIONS_SHOWN && (
        <button
          type="button"
          onClick={() => setAll((v) => !v)}
          aria-expanded={all}
          className="mt-1 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          {all
            ? t("stationsSummary.showFewer")
            : t("stationsSummary.showAll", { count: list.length })}
          {all ? (
            <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
          )}
        </button>
      )}
    </div>
  );
}

const PAY_ICON = { autopay: CreditCard, cash_check: Banknote, invoiced: FileText } as const;
const PAY_KEY = {
  autopay: "pay.autopay",
  cash_check: "pay.cashCheck",
  invoiced: "pay.invoiced",
} as const;

/**
 * How this customer pays, what they owe, and what is already waiting for the
 * office -- and, when there is something owed and the tech may record it, the
 * button that opens the form.
 */
export function PaymentLine({
  facts,
  locale,
  onCollect,
}: {
  facts: StopFacts;
  locale?: string;
  /** Present when this tech may record a collection here. */
  onCollect?: () => void;
}) {
  const { t } = useTranslation();
  const mode = paymentMode(facts);
  const Icon = PAY_ICON[mode];
  const due = dueCents(facts);
  return (
    <div className="mt-2.5 space-y-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-sm">
        <span
          className={`inline-flex max-w-full min-w-0 items-center gap-1.5 rounded-2xl border px-2.5 py-1 font-medium ${
            mode === "cash_check"
              ? "border-emerald-600/40 bg-emerald-600/10 text-emerald-800 dark:text-emerald-300"
              : "border-border bg-muted/50 text-foreground/80"
          }`}
        >
          <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span className="min-w-0">{t(PAY_KEY[mode])}</span>
        </span>
        {due > 0 && (
          <span className="rounded-full bg-amber-500/15 px-2.5 py-1 font-semibold text-amber-800 dark:text-amber-300">
            {t("pay.due", { amount: formatMoney(due, locale) })}
          </span>
        )}
        {facts.awaitingCents > 0 && (
          <span className="inline-flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
            <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0">
              {t("pay.waiting", { amount: formatMoney(facts.awaitingCents, locale) })}
            </span>
          </span>
        )}
      </div>
      {onCollect && due > 0 && (
        <Button type="button" variant="outline" className="h-11 w-full" onClick={onCollect}>
          <Banknote className="mr-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {t("pay.collect")}
        </Button>
      )}
    </div>
  );
}

export type CollectAnswer = {
  amountCents: number;
  method: "cash" | "check";
  reference?: string;
};

/**
 * Amount (starting at what is owed, and allowed to be less), cash or check,
 * and the check number. The bounds are the database's -- more than the open
 * balance is refused there too -- but saying so here is what keeps a refusal
 * from being queued in a dead zone and failing on replay.
 */
export function CollectForm({
  idPrefix,
  dueCents: due,
  locale,
  pending,
  onSubmit,
  onCancel,
}: {
  idPrefix: string;
  dueCents: number;
  locale?: string;
  pending: boolean;
  onSubmit: (a: CollectAnswer) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [amount, setAmount] = useState(() => (due / 100).toFixed(2));
  const [method, setMethod] = useState<"cash" | "check">("cash");
  const [reference, setReference] = useState("");
  const cents = parseDollars(amount);
  const problem = collectionAmountProblem(cents, due);
  return (
    <form
      className="space-y-3 rounded-lg border bg-muted/30 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (problem || cents == null) return;
        onSubmit({
          amountCents: cents,
          method,
          reference: method === "check" ? reference.trim() || undefined : undefined,
        });
      }}
    >
      <div className="text-sm font-semibold">{t("pay.heading")}</div>
      <div>
        <Label htmlFor={`${idPrefix}-amount`} className="text-xs">
          {t("pay.amount")}
        </Label>
        <Input
          id={`${idPrefix}-amount`}
          inputMode="decimal"
          autoComplete="off"
          className="mt-1 h-11 text-base tabular-nums"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
        />
        {problem && amount.trim() !== "" && (
          <p className="mt-1 text-xs font-medium text-destructive">
            {problem === "moreThanDue"
              ? t("pay.moreThanDue", { amount: formatMoney(due, locale) })
              : t("pay.enterAmount")}
          </p>
        )}
      </div>
      <fieldset>
        <legend className="text-xs font-medium">{t("pay.method")}</legend>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {(["cash", "check"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={method === m}
              onClick={() => setMethod(m)}
              className={`min-h-11 rounded-md border px-3 text-sm font-medium transition-colors ${
                method === m
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input bg-background hover:bg-muted"
              }`}
            >
              {m === "cash" ? t("pay.cash") : t("pay.check")}
            </button>
          ))}
        </div>
      </fieldset>
      {method === "check" && (
        <div>
          <Label htmlFor={`${idPrefix}-check`} className="text-xs">
            {t("pay.checkNumber")}
          </Label>
          <Input
            id={`${idPrefix}-check`}
            inputMode="numeric"
            autoComplete="off"
            maxLength={120}
            className="mt-1 h-11"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
          />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <Button type="button" variant="ghost" className="h-11" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" className="h-11" disabled={pending || !!problem}>
          {pending ? t("pay.saving") : t("pay.save")}
        </Button>
      </div>
      <p className="text-2xs text-muted-foreground">{t("pay.officeConfirms")}</p>
    </form>
  );
}
