// What a walk adds to a My Day card (#410): its length and group, how the
// walker gets in, the minutes out, and the report the client gets.
//
// Only drawn for a stop whose service is a dog walk (isWalkVisit). A
// pet-waste stop never reaches any of this, so its card is unchanged.
//
// A tech screen (tests/support/tech-screens.ts): every word through t(), and
// sides spelled logically for Arabic.

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { AlertTriangle, DoorOpen, Footprints, KeyRound, Timer, Users } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useServerFn } from "@tanstack/react-start";
import { recordWalkReport } from "@/lib/walk-report.functions";
import { listWalksOverDogCap } from "@/lib/walk-groups.functions";
import { overCapByVisit } from "@/lib/dog-cap";
import { REPORT_NOTE_MAX, cleanReportNote } from "@/lib/walk-report";
import { enqueueAction } from "@/lib/offline/queue";
import { runOrQueue } from "@/lib/offline/run-or-queue";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import { createWalkDraftKeeper, type WalkDraftKeeper } from "@/lib/offline/walk-drafts";
import { isAccessMethod, type AccessMethod } from "@/lib/walk-access";
import {
  groupWalkMates,
  minutesOut,
  walkLengthMin,
  type DayVisit,
} from "@/lib/walk-day";

export { isWalkVisit } from "@/lib/walk-day";

/** Minutes out on the walk, from started_at. Once a minute, no animation, and
 *  nothing but the clock: no location is read. */
export function WalkTimer({ startedAt }: { startedAt: string }) {
  const { t } = useTranslation();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const minutes = minutesOut(startedAt, now);
  if (minutes == null) return null;
  return (
    <span className="inline-flex items-center gap-1 text-sm font-semibold text-blue-700 dark:text-blue-300">
      <Timer className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="tabular-nums">{t("walk.minutesOut", { minutes })}</span>
    </span>
  );
}

/** The walk's booked length, and for a group walk the chip and the pickup
 *  order, read from the day's own list. */
export function WalkMeta({ visit, dayVisits }: { visit: DayVisit; dayVisits: readonly DayVisit[] }) {
  const { t } = useTranslation();
  const length = walkLengthMin(visit);
  const mates = groupWalkMates(visit, dayVisits);
  const overCap = useOverDogCap(visit);
  if (length == null && mates.length === 0 && !overCap) return null;
  return (
    <div className="mt-1 space-y-1.5 text-sm">
      {/* The office confirmed this walk over the walker's dog cap (#731). It
          stays flagged until the walk is back under. */}
      {overCap && (
        <p
          role="status"
          data-testid="over-dog-cap"
          className="flex min-w-0 items-start gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs font-semibold text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span className="min-w-0 break-words">
            {t("walk.overDogCap", { dogs: overCap.dogs, cap: overCap.cap })}
          </span>
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {length != null && (
          <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
            <Footprints className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            {t("walk.length", { minutes: length })}
          </span>
        )}
        {mates.length > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
            <Users className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t("walk.groupWalk")}
          </span>
        )}
      </div>
      {mates.length > 1 && (
        <div className="rounded-lg border bg-muted/30 p-2.5">
          <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("walk.pickupOrder")}
          </div>
          <ol className="mt-1 space-y-1">
            {mates.map((m) => (
              <li key={m.id} className="flex min-w-0 items-baseline gap-2">
                <span className="w-5 shrink-0 text-end font-semibold tabular-nums">{m.order}</span>
                <span className={`min-w-0 flex-1 truncate ${m.isThis ? "font-semibold" : ""}`}>
                  <bdi>{m.label}</bdi>
                  {m.street ? (
                    <span className="text-muted-foreground">
                      {" · "}
                      <bdi>{m.street}</bdi>
                    </span>
                  ) : null}
                </span>
                {m.isThis && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {t("walk.thisStop")}
                  </span>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** This stop's walk, when it is over the walker's dog cap on its day. One
 *  request per day, shared by every card; a failed lookup (no signal) shows
 *  no flag rather than blocking the card. */
function useOverDogCap(visit: DayVisit) {
  const list = useServerFn(listWalksOverDogCap);
  const day = visit.scheduled_on ?? null;
  const { data } = useQuery({
    queryKey: ["my-day", "over-dog-cap", day],
    queryFn: () => list({ data: { day: day! } }),
    enabled: Boolean(day && visit.walk_group_id),
    staleTime: 60_000,
    retry: false,
  });
  return data ? (overCapByVisit(data.walks).get(visit.id) ?? null) : null;
}

type AccessProps = {
  access_method?: string | null;
  key_held?: boolean | null;
  key_tag?: string | null;
} | null;

/** How the walker gets in, in words, and whether the office holds the key.
 *  The codes themselves stay in the card's existing access block. */
export function WalkAccess({ property }: { property: AccessProps | undefined }) {
  const { t } = useTranslation();
  const raw = property?.access_method;
  const method = isAccessMethod(raw) ? raw : null;
  const keyHeld = !!property?.key_held;
  if (!method && !keyHeld) return null;
  const tag = property?.key_tag?.trim();
  return (
    <div className="mt-2.5 space-y-1.5 rounded-lg border bg-muted/30 p-2.5 text-sm">
      {method && (
        <div className="flex min-w-0 items-start gap-2">
          <DoorOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("walk.wayIn")}
            </div>
            <div className="font-medium leading-tight">{accessMethodText(t, method)}</div>
          </div>
        </div>
      )}
      {keyHeld && (
        <div className="flex min-w-0 items-start gap-2">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {/* The tag is the office's code, left to right in every language:
                isolated (U+2066 ... U+2069) so "K-12" keeps its order inside
                an Arabic sentence. */}
            {tag
              ? t("walk.officeHoldsKeyTag", { tag: `⁦${tag}⁩` })
              : t("walk.officeHoldsKey")}
          </span>
        </div>
      )}
    </div>
  );
}

function accessMethodText(t: TFunction, m: AccessMethod): string {
  switch (m) {
    case "key":
      return t("walk.access.key");
    case "lockbox":
      return t("walk.access.lockbox");
    case "code":
      return t("walk.access.code");
    case "garage":
      return t("walk.access.garage");
    case "person_home":
      return t("walk.access.personHome");
  }
}

export type WalkReportState = {
  pee: boolean | null;
  poo: boolean | null;
  note: string;
  setPee: (v: boolean | null) => void;
  setPoo: (v: boolean | null) => void;
  setNote: (v: string) => void;
  /** Records the report before the completion, live or queued. Resolves
   *  `queued: true` when it went to the device's queue, in which case the
   *  completion has to queue behind it rather than overtake it. */
  send: () => Promise<{ queued: boolean; sent: boolean }>;
  reset: () => void;
};

/** The walk report a walker fills in before ending the walk. Pee and poo start
 *  unset: "not recorded" is a different answer from "no".
 *
 *  Kept on the device per visit as it is typed (#610), so Client info, a
 *  reload or the app being killed does not empty it. The saved draft is read
 *  back on mount; a field the walker touched before it arrived keeps what they
 *  typed. Cleared once End walk has recorded the report, and on reset. */
export function useWalkReport(visitId: string): WalkReportState {
  const [pee, setPeeState] = useState<boolean | null>(null);
  const [poo, setPooState] = useState<boolean | null>(null);
  const [note, setNoteState] = useState("");
  const [hydrated, setHydrated] = useState(false);
  const touched = useRef({ pee: false, poo: false, note: false });
  const keeper = useRef<WalkDraftKeeper | null>(null);
  const reportFn = useServerFn(recordWalkReport);

  useEffect(() => {
    const k = createWalkDraftKeeper(visitId);
    keeper.current = k;
    touched.current = { pee: false, poo: false, note: false };
    setHydrated(false);
    setPeeState(null);
    setPooState(null);
    setNoteState("");
    let live = true;
    void k.load().then((d) => {
      if (!live) return;
      if (d) {
        if (!touched.current.pee) setPeeState(d.pee);
        if (!touched.current.poo) setPooState(d.poo);
        if (!touched.current.note) setNoteState(d.note);
      }
      setHydrated(true);
    });
    return () => {
      live = false;
    };
  }, [visitId]);

  // Every change, written straight away: a note typed just before Client info
  // or a kill is the one that matters. Nothing is written until the saved
  // draft has been read, so an empty first render never overwrites it.
  useEffect(() => {
    if (!hydrated) return;
    void keeper.current?.save({ pee, poo, note });
  }, [hydrated, pee, poo, note]);

  const setPee = useCallback((v: boolean | null) => {
    touched.current.pee = true;
    setPeeState(v);
  }, []);
  const setPoo = useCallback((v: boolean | null) => {
    touched.current.poo = true;
    setPooState(v);
  }, []);
  const setNote = useCallback((v: string) => {
    touched.current.note = true;
    setNoteState(v);
  }, []);

  const send = useCallback(async () => {
    const reportNote = cleanReportNote(note);
    // Nothing recorded is nothing to send: the visit's columns are already
    // empty, and a round trip that can only fail is not worth a dead zone.
    if (pee == null && poo == null && reportNote == null) return { queued: false, sent: false };
    const r = await runOrQueue({
      online: !isDefinitelyOffline(),
      label: "Walk report",
      send: () => reportFn({ data: { visitId, pee, poo, reportNote } }),
      queue: async () => {
        await enqueueAction({
          kind: "walk_report",
          visitId,
          pee,
          poo,
          reportNote,
          userId: await resolveOfflineUserId(),
        });
      },
    });
    // Recorded, live or queued: the draft has done its job.
    await keeper.current?.clear();
    return { queued: r.queued, sent: true };
  }, [note, pee, poo, reportFn, visitId]);

  const reset = useCallback(() => {
    setPeeState(null);
    setPooState(null);
    setNoteState("");
    void keeper.current?.clear();
  }, []);

  return { pee, poo, note, setPee, setPoo, setNote, send, reset };
}

/** Yes / No, with a second tap on the chosen one clearing it. 44px tall. */
function YesNo({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const { t } = useTranslation();
  const option = (v: boolean, text: string) => (
    <button
      type="button"
      aria-pressed={value === v}
      onClick={() => onChange(value === v ? null : v)}
      className={`min-h-11 min-w-0 flex-1 rounded-md border px-3 text-sm font-medium ${
        value === v
          ? "border-primary bg-primary text-primary-foreground"
          : "bg-background text-foreground active:bg-accent"
      }`}
    >
      {text}
    </button>
  );
  return (
    <div role="group" aria-labelledby={id} className="min-w-0">
      <div id={id} className="mb-1 text-xs font-semibold text-muted-foreground">
        {label}
      </div>
      <div className="flex gap-2">
        {option(true, t("walk.yes"))}
        {option(false, t("walk.no"))}
      </div>
    </div>
  );
}

/** Pee, poo and the note for the client, shown while the walk is under way. */
export function WalkReportFields({ visitId, report }: { visitId: string; report: WalkReportState }) {
  const { t } = useTranslation();
  const noteId = `walk-note-${visitId}`;
  return (
    <fieldset className="space-y-3 rounded-lg border p-2.5">
      <legend className="px-1.5 text-xs font-semibold uppercase text-muted-foreground">
        {t("walk.reportHeading")}
      </legend>
      <div className="grid grid-cols-1 gap-3 min-[360px]:grid-cols-2">
        <YesNo
          id={`walk-pee-${visitId}`}
          label={t("walk.pee")}
          value={report.pee}
          onChange={report.setPee}
        />
        <YesNo
          id={`walk-poo-${visitId}`}
          label={t("walk.poo")}
          value={report.poo}
          onChange={report.setPoo}
        />
      </div>
      <div>
        <Label htmlFor={noteId} className="text-xs">
          {t("walk.noteForClient")}
        </Label>
        <Textarea
          id={noteId}
          // The walker's own words take their own direction.
          dir="auto"
          rows={2}
          maxLength={REPORT_NOTE_MAX}
          placeholder={t("walk.noteForClientPlaceholder")}
          value={report.note}
          onChange={(e) => report.setNote(e.target.value)}
        />
      </div>
    </fieldset>
  );
}
