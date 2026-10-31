// What a pet sitting visit adds to a My Day card (#411): the stay (drop-in or
// overnight, which visit of the stay this is, its dates), the pets with their
// care instructions, the care log, and the note the client gets.
//
// Only drawn for a stop whose service is pet sitting (isSitVisit). A
// pet-waste or walking stop never reaches any of this, so its card is
// unchanged. How the sitter gets in is the walk's block (WalkAccess), reused.
//
// A tech screen (tests/support/tech-screens.ts): every word through t(), and
// sides spelled logically for Arabic.

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  AlertTriangle,
  BedDouble,
  CalendarDays,
  Cat,
  Dog,
  Droplets,
  Footprints,
  HeartPulse,
  LockKeyhole,
  PawPrint,
  PhoneCall,
  Pill,
  Sparkles,
  Stethoscope,
  Undo2,
  UserRoundPen,
  UtensilsCrossed,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { deleteCareEntry, recordCareEntry } from "@/lib/care-log.functions";
import { REPORT_NOTE_MAX } from "@/lib/walk-report";
import { stayAccessOpen, stayAccessWindow, stayDays } from "@/lib/stays";
import { useOrgToday } from "@/hooks/useOrgToday";
import { orgLocalDay, orgLocalTime } from "@/lib/org-day";
import { haptic } from "@/lib/haptics";
import { newClientKey } from "@/lib/stop-facts";
import { deleteAction, enqueueAction, listPending, type PendingAction } from "@/lib/offline/queue";
import { runOrQueue } from "@/lib/offline/run-or-queue";
import { isDefinitelyOffline } from "@/lib/offline/connectivity";
import { resolveOfflineUserId } from "@/lib/offline/action-owner";
import {
  MISSED_REASON_MAX,
  byTime,
  cleanMissedReason,
  isOvernight,
  medEntry,
  sitPets,
  stayProgress,
  unloggedDueMeds,
  type CareEntry,
  type CareKind,
  type SitEmergency,
  type SitFacts,
  type SitPet,
} from "@/lib/sit-day";
import type { WalkReportState } from "@/components/my-day/WalkParts";

export { isSitVisit, sitEmergency } from "@/lib/sit-day";

type SitVisit = {
  id: string;
  sit_facts?: SitFacts | null;
  /** Whether stay_access_codes returned this stay (src/lib/sit-day.server.ts). */
  stay_codes_shown?: boolean;
  care_entries?: CareEntry[] | null;
  properties?: { dogs?: unknown[] | null } | null;
};

/** The pets this visit is for, with their care, from the day's own data. */
export function useSitPets(visit: SitVisit): SitPet[] {
  const dogs = visit.properties?.dogs;
  const facts = visit.sit_facts;
  return useMemo(() => sitPets((dogs ?? []) as any[], facts), [dogs, facts]);
}

/** "Start visit" / "End visit" for a drop-in, "Check in" / "Check out" for an
 *  overnight. */
export function sitStepLabel(
  t: TFunction,
  facts: SitFacts | null | undefined,
  step: "start" | "end",
) {
  if (isOvernight(facts)) return step === "start" ? t("sit.checkIn") : t("sit.checkOut");
  return step === "start" ? t("sit.startVisit") : t("sit.endVisit");
}

function dayLabel(day: string, locale: string | undefined): string {
  const d = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return d.toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The stay: drop-in or overnight, "Night 2 of 5", and its dates. */
export function SitMeta({ visit, locale }: { visit: SitVisit; locale?: string }) {
  const { t } = useTranslation();
  const facts = visit.sit_facts;
  if (!facts) return null;
  const overnight = isOvernight(facts);
  const progress = stayProgress(facts);
  const from = dayLabel(facts.starts_on, locale);
  const to = dayLabel(facts.ends_on, locale);
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">
        {overnight ? (
          <BedDouble className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        ) : (
          <PawPrint className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        )}
        {overnight ? t("sit.overnight") : t("sit.dropIn")}
      </span>
      {progress && (
        <span className="font-medium text-foreground">
          {progress.unit === "night"
            ? t("sit.nightOf", { n: progress.n, total: progress.total })
            : t("sit.visitOf", { n: progress.n, total: progress.total })}
        </span>
      )}
      <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
        <CalendarDays className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">
          {overnight ? t("sit.checkInOut", { from, to }) : t("sit.dates", { from, to })}
        </span>
      </span>
    </div>
  );
}

/** When the stay's codes are not on the card: the day they show, or that
 *  only the stay's sitter sees them. Nothing once the stay is over. */
export function SitCodesHint({ visit, locale }: { visit: SitVisit; locale?: string }) {
  const { t } = useTranslation();
  const today = useOrgToday();
  const facts = visit.sit_facts;
  if (!facts || visit.stay_codes_shown) return null;
  const kind = isOvernight(facts) ? "overnight" : "drop_in";
  const open = stayAccessWindow(stayDays(kind, facts.starts_on, facts.ends_on));
  if (!open || today > open.through) return null;
  return (
    <div className="mt-2 flex items-start gap-2 text-sm text-muted-foreground">
      <LockKeyhole className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {stayAccessOpen(today, open)
          ? t("sit.codesSitterOnly")
          : t("sit.codesFrom", { date: dayLabel(open.from, locale) })}
      </span>
    </div>
  );
}

function SpeciesIcon({ pet }: { pet: SitPet }) {
  if (pet.species === "cat")
    return <Cat className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  if (pet.species === "dog")
    return <Dog className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
  return <PawPrint className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />;
}

function speciesText(t: TFunction, pet: SitPet) {
  if (pet.species === "cat") return t("sit.species.cat");
  if (pet.species === "dog") return t("sit.species.dog");
  // What the office typed ("rabbit") is the business's own word.
  return pet.speciesNote ? <bdi>{pet.speciesNote}</bdi> : t("sit.species.other");
}

function clockLabel(time: string, locale: string | undefined): string {
  const [h, m] = time.split(":").map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return time;
  return new Date(Date.UTC(2000, 0, 1, h, m)).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

/** Each pet, what kind, and how it is looked after: feeding, every med with
 *  its dose and times, and anything else the office wrote down. */
export function SitPetsCare({ pets, tz, locale }: { pets: SitPet[]; tz: string; locale?: string }) {
  const { t } = useTranslation();
  if (pets.length === 0) {
    return (
      <div className="mt-2 flex items-center gap-1.5 text-sm text-muted-foreground">
        <PawPrint className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0">{t("sit.noPets")}</span>
      </div>
    );
  }
  return (
    <ul className="mt-2.5 space-y-2">
      {pets.map((pet) => (
        <li key={pet.id} className="rounded-lg border bg-muted/30 p-2.5 text-sm">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <SpeciesIcon pet={pet} />
            <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">
              <bdi>{pet.name || t("sit.petFallback")}</bdi>
            </span>
            <span className="text-xs text-muted-foreground">{speciesText(t, pet)}</span>
          </div>
          {pet.clientUpdatedAt && (
            <div
              data-care-updated-by-client={pet.id}
              className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground"
            >
              <UserRoundPen className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">
                {t("sit.updatedByClient", {
                  date: dayLabel(orgLocalDay(pet.clientUpdatedAt, tz), locale),
                })}
              </span>
            </div>
          )}
          {pet.care?.feeding && (
            <CareFact icon={UtensilsCrossed} label={t("sit.feeding")}>
              <bdi className="whitespace-pre-line">{pet.care.feeding}</bdi>
            </CareFact>
          )}
          {(pet.care?.meds ?? []).map((med, i) => (
            <CareFact key={`${med.name}-${i}`} icon={Pill} label={t("sit.med")}>
              <bdi className="font-medium">{med.name}</bdi>
              {med.dose ? (
                <>
                  {" · "}
                  <bdi>{med.dose}</bdi>
                </>
              ) : null}
              {" · "}
              {med.times.length > 0
                ? t("sit.medTimes", {
                    times: med.times.map((x) => clockLabel(x, locale)).join(", "),
                  })
                : t("sit.asNeeded")}
              {med.notes ? (
                <span className="block text-muted-foreground">
                  <bdi>{med.notes}</bdi>
                </span>
              ) : null}
            </CareFact>
          ))}
          {pet.care?.other_care && (
            <CareFact icon={Sparkles} label={t("sit.otherCare")}>
              <bdi className="whitespace-pre-line">{pet.care.other_care}</bdi>
            </CareFact>
          )}
          <CareFact icon={Stethoscope} label={t("sit.vet")}>
            {pet.vet ? (
              <>
                {pet.vet.name && <bdi>{pet.vet.name}</bdi>}
                {pet.vet.name && pet.vet.phone ? " · " : null}
                {pet.vet.phone && <PhoneLink phone={pet.vet.phone} />}
              </>
            ) : (
              <span className="text-amber-700 dark:text-amber-400">{t("sit.noVet")}</span>
            )}
          </CareFact>
        </li>
      ))}
    </ul>
  );
}

function PhoneLink({ phone }: { phone: string }) {
  return (
    <a
      href={`tel:${phone.replace(/[^\d+]/g, "")}`}
      className="inline-flex items-center font-medium text-primary underline-offset-2 hover:underline touch:min-h-11"
    >
      <span dir="ltr">{phone}</span>
    </a>
  );
}

/** Who to call when a pet is sick: the client's emergency contact, whether
 *  they may approve vet care, and what the sitter may spend without asking.
 *  Each pet's vet is with the pet (SitPetsCare). */
export function SitEmergencyFacts({
  emergency,
  locale,
}: {
  emergency: SitEmergency;
  locale?: string;
}) {
  const { t } = useTranslation();
  const limit =
    emergency.limitCents == null
      ? null
      : new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(
          emergency.limitCents / 100,
        );
  return (
    <div className="mt-2.5 rounded-lg border bg-muted/30 p-2.5 text-sm">
      <CareFact icon={PhoneCall} label={t("sit.emergencyContact")}>
        {emergency.name || emergency.phone ? (
          <>
            {emergency.name && <bdi>{emergency.name}</bdi>}
            {emergency.name && emergency.phone ? " · " : null}
            {emergency.phone && <PhoneLink phone={emergency.phone} />}
            <span className="block text-muted-foreground">
              {emergency.mayApproveVet ? t("sit.mayApproveVet") : t("sit.mayNotApproveVet")}
            </span>
          </>
        ) : (
          <span className="text-amber-700 dark:text-amber-400">{t("sit.noEmergencyContact")}</span>
        )}
      </CareFact>
      <CareFact icon={HeartPulse} label={t("sit.treatmentLimit")}>
        {limit ? (
          t("sit.treatmentLimitValue", { amount: limit })
        ) : (
          <span className="text-amber-700 dark:text-amber-400">{t("sit.noTreatmentLimit")}</span>
        )}
      </CareFact>
    </div>
  );
}

function CareFact({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof Pill;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="mt-1.5 flex min-w-0 items-start gap-2">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 [overflow-wrap:anywhere]">
        <div className="text-3xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </div>
        <div className="leading-snug">{children}</div>
      </div>
    </div>
  );
}

// ── The care log ─────────────────────────────────────────────────────────

type LogInput = {
  petId: string | null;
  kind: CareKind;
  medName?: string | null;
  status?: "done" | "missed";
  missedReason?: string | null;
};

export type SitCareState = {
  entries: CareEntry[];
  /** Entries logged on this card since it was opened: the ones Undo offers. */
  sessionIds: ReadonlySet<string>;
  log: (input: LogInput) => Promise<{ queued: boolean }>;
  undo: (entry: CareEntry) => Promise<void>;
  /** Whether an entry or an undo for this visit is still on the device's
   *  queue, in which case the completion queues behind it. */
  hasQueued: () => Promise<boolean>;
};

const isCareAction = (a: PendingAction, visitId: string) =>
  (a.kind === "care_entry" || a.kind === "care_entry_undo") && a.visitId === visitId;

/** The care log a sitter fills in during the visit: what the server has, what
 *  this device has queued, and what was tapped since the card opened. */
export function useSitCare(visit: SitVisit, enabled: boolean): SitCareState {
  const visitId = visit.id;
  const recordFn = useServerFn(recordCareEntry);
  const undoFn = useServerFn(deleteCareEntry);
  const [local, setLocal] = useState<CareEntry[]>([]);
  const [deviceQueued, setDeviceQueued] = useState<CareEntry[]>([]);
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set());
  const [sessionIds, setSessionIds] = useState<ReadonlySet<string>>(new Set());

  // Entries waiting on this device, so a reload in a dead zone still shows
  // them, marked as queued. Not read at all for a stop that is not a sit:
  // every other card on the day costs what it did.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const refresh = () => {
      resolveOfflineUserId()
        .then((uid) => listPending(uid))
        .then((actions) => {
          if (cancelled) return;
          setDeviceQueued(
            actions.flatMap((a) =>
              a.kind === "care_entry" && a.visitId === visitId
                ? [
                    {
                      id: a.entryId,
                      pet_id: a.petId,
                      kind: a.careKind,
                      med_name: a.medName,
                      status: a.status,
                      missed_reason: a.missedReason,
                      note: a.note,
                      at: new Date(a.ts).toISOString(),
                      queued: true,
                    } satisfies CareEntry,
                  ]
                : [],
            ),
          );
        })
        .catch(() => {
          if (!cancelled) setDeviceQueued([]);
        });
    };
    refresh();
    window.addEventListener("offline-queue-change", refresh);
    return () => {
      cancelled = true;
      window.removeEventListener("offline-queue-change", refresh);
    };
  }, [visitId, enabled]);

  const server = visit.care_entries;
  const entries = useMemo(() => {
    const queuedIds = new Set(deviceQueued.map((e) => e.id));
    const byId = new Map<string, CareEntry>();
    for (const e of server ?? []) byId.set(e.id, e);
    for (const e of deviceQueued) if (!byId.has(e.id)) byId.set(e.id, e);
    for (const e of local) if (!byId.has(e.id)) byId.set(e.id, e);
    return byTime(
      [...byId.values()]
        .filter((e) => !removed.has(e.id))
        .map((e) => ({ ...e, queued: queuedIds.has(e.id) })),
    );
  }, [server, deviceQueued, local, removed]);

  const log = useCallback(
    async (input: LogInput) => {
      // Minted before the first attempt: a replay of a request that landed
      // after its deadline is the same row, and Undo can name it.
      const id = newClientKey();
      const status = input.status ?? "done";
      const entry: CareEntry = {
        id,
        pet_id: input.petId,
        kind: input.kind,
        med_name: input.kind === "meds" ? (input.medName ?? null) : null,
        status,
        missed_reason: status === "missed" ? cleanMissedReason(input.missedReason) : null,
        note: null,
        at: new Date().toISOString(),
      };
      setLocal((l) => [...l, entry]);
      setSessionIds((s) => new Set(s).add(id));
      try {
        return await runOrQueue({
          online: !isDefinitelyOffline(),
          label: "Care entry",
          send: () =>
            recordFn({
              data: {
                id,
                visitId,
                petId: entry.pet_id,
                kind: entry.kind,
                medName: entry.med_name,
                status: entry.status,
                missedReason: entry.missed_reason,
                note: null,
              },
            }),
          queue: async () => {
            await enqueueAction({
              kind: "care_entry",
              visitId,
              entryId: id,
              petId: entry.pet_id,
              careKind: entry.kind,
              medName: entry.med_name,
              status: entry.status,
              missedReason: entry.missed_reason,
              note: null,
              userId: await resolveOfflineUserId(),
            });
          },
        });
      } catch (e) {
        // The server refused it: it is not logged, so it is not shown.
        setLocal((l) => l.filter((x) => x.id !== id));
        throw e;
      }
    },
    [recordFn, visitId],
  );

  const undo = useCallback(
    async (entry: CareEntry) => {
      setRemoved((s) => new Set(s).add(entry.id));
      try {
        // Still on this device: take it off the queue, and the server never
        // hears of it.
        const uid = await resolveOfflineUserId();
        const waiting = (await listPending(uid)).find(
          (a) => a.kind === "care_entry" && a.entryId === entry.id,
        );
        if (waiting) {
          await deleteAction(waiting.id);
          return;
        }
        await runOrQueue({
          online: !isDefinitelyOffline(),
          label: "Undo care entry",
          send: () => undoFn({ data: { id: entry.id } }),
          queue: async () => {
            await enqueueAction({
              kind: "care_entry_undo",
              visitId,
              entryId: entry.id,
              userId: uid,
            });
          },
        });
      } catch (e) {
        setRemoved((s) => {
          const next = new Set(s);
          next.delete(entry.id);
          return next;
        });
        throw e;
      }
    },
    [undoFn, visitId],
  );

  const hasQueued = useCallback(async () => {
    if (!enabled) return false;
    try {
      const uid = await resolveOfflineUserId();
      return (await listPending(uid)).some((a) => isCareAction(a, visitId));
    } catch {
      return false;
    }
  }, [visitId, enabled]);

  return { entries, sessionIds, log, undo, hasQueued };
}

function entryText(t: TFunction, e: CareEntry): string {
  const what =
    e.kind === "meds"
      ? (e.med_name ?? t("sit.med"))
      : e.kind === "feed"
        ? t("sit.fed")
        : e.kind === "water"
          ? t("sit.water")
          : e.kind === "litter"
            ? t("sit.litter")
            : e.kind === "walk"
              ? t("sit.walked")
              : t("sit.other");
  if (e.status === "missed") return t("sit.entryMissed", { what, reason: e.missed_reason ?? "" });
  return e.kind === "meds" ? t("sit.entryGiven", { what }) : what;
}

/** A care button: 44px tall, the label wraps rather than widening the row. */
function CareButton({
  icon: Icon,
  children,
  onClick,
  disabled,
  pressed,
  tone = "default",
}: {
  icon: typeof Pill;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  tone?: "default" | "warn";
}) {
  return (
    <Button
      type="button"
      variant="outline"
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      className={`h-auto min-h-11 min-w-0 shrink-0 whitespace-normal px-3 py-2 text-sm ${
        tone === "warn" ? "border-amber-500/50 text-amber-800 dark:text-amber-300" : ""
      } ${pressed ? "border-primary bg-primary/10" : ""}`}
    >
      <Icon className="me-1.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0">{children}</span>
    </Button>
  );
}

/** The care log, shown while the visit is under way: quick buttons per pet,
 *  each med Given or Missed (missed asks why), the entries so far with the
 *  time and who, Undo for what was tapped here, and a warning for a dose due
 *  now that nobody has logged. The warning never blocks ending the visit. */
export function SitCareLog({
  visit,
  pets,
  care,
  tz,
  locale,
  disabled = false,
}: {
  visit: SitVisit;
  pets: SitPet[];
  care: SitCareState;
  tz: string;
  locale?: string;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState<{ petId: string; med: string } | null>(null);
  const [reason, setReason] = useState("");

  const run = async (input: LogInput) => {
    setBusy(true);
    try {
      const r = await care.log(input);
      haptic("select");
      toast.success(r.queued ? t("sit.loggedQueued") : t("sit.logged"));
      return true;
    } catch (e) {
      haptic("error");
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const undo = async (e: CareEntry) => {
    try {
      await care.undo(e);
      toast.success(t("sit.undone"));
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  const due = unloggedDueMeds(pets, care.entries, visit.sit_facts);
  const nameOf = (id: string | null) =>
    (id && pets.find((p) => p.id === id)?.name) || t("sit.allPets");
  const reasonId = `sit-missed-${visit.id}`;

  return (
    <fieldset className="space-y-3 rounded-lg border p-2.5">
      <legend className="px-1.5 text-xs font-semibold uppercase text-muted-foreground">
        {t("sit.logHeading")}
      </legend>

      {pets.map((pet) => (
        <div key={pet.id} className="space-y-2">
          <div className="flex min-w-0 items-center gap-1.5 text-sm font-semibold">
            <SpeciesIcon pet={pet} />
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <bdi>{pet.name || t("sit.petFallback")}</bdi>
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            <CareButton
              icon={UtensilsCrossed}
              disabled={disabled || busy}
              onClick={() => run({ petId: pet.id, kind: "feed" })}
            >
              {t("sit.fed")}
            </CareButton>
            <CareButton
              icon={Droplets}
              disabled={disabled || busy}
              onClick={() => run({ petId: pet.id, kind: "water" })}
            >
              {t("sit.water")}
            </CareButton>
            <CareButton
              icon={Sparkles}
              disabled={disabled || busy}
              onClick={() => run({ petId: pet.id, kind: "litter" })}
            >
              {t("sit.litter")}
            </CareButton>
            {pet.species === "dog" && (
              <CareButton
                icon={Footprints}
                disabled={disabled || busy}
                onClick={() => run({ petId: pet.id, kind: "walk" })}
              >
                {t("sit.walked")}
              </CareButton>
            )}
          </div>

          {(pet.care?.meds ?? []).map((med, i) => {
            const logged = medEntry(care.entries, pet.id, med.name);
            const open = missing?.petId === pet.id && missing.med === med.name;
            return (
              <div key={`${med.name}-${i}`} className="rounded-md bg-muted/40 p-2">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <Pill className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="min-w-0 flex-1 text-sm font-medium [overflow-wrap:anywhere]">
                    <bdi>{med.name}</bdi>
                    {med.dose ? (
                      <span className="font-normal text-muted-foreground">
                        {" · "}
                        <bdi>{med.dose}</bdi>
                      </span>
                    ) : null}
                  </span>
                  {logged ? (
                    <span
                      className={`text-xs font-semibold ${
                        logged.status === "missed"
                          ? "text-amber-700 dark:text-amber-300"
                          : "text-emerald-700 dark:text-emerald-300"
                      }`}
                    >
                      {logged.status === "missed" ? t("sit.missed") : t("sit.given")}
                    </span>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      <CareButton
                        icon={Pill}
                        disabled={disabled || busy}
                        onClick={() => run({ petId: pet.id, kind: "meds", medName: med.name })}
                      >
                        {t("sit.given")}
                      </CareButton>
                      <CareButton
                        icon={AlertTriangle}
                        tone="warn"
                        pressed={open}
                        disabled={disabled || busy}
                        onClick={() => {
                          setReason("");
                          setMissing(open ? null : { petId: pet.id, med: med.name });
                        }}
                      >
                        {t("sit.missed")}
                      </CareButton>
                    </div>
                  )}
                </div>
                {open && !logged && (
                  <div className="mt-2 space-y-2">
                    <Label htmlFor={reasonId} className="text-xs">
                      {t("sit.missedReasonLabel", { med: med.name })}
                    </Label>
                    <Textarea
                      id={reasonId}
                      dir="auto"
                      rows={2}
                      maxLength={MISSED_REASON_MAX}
                      placeholder={t("sit.missedReasonPlaceholder")}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        type="button"
                        className="min-h-11 shrink-0"
                        disabled={disabled || busy || !cleanMissedReason(reason)}
                        onClick={async () => {
                          const ok = await run({
                            petId: pet.id,
                            kind: "meds",
                            medName: med.name,
                            status: "missed",
                            missedReason: reason,
                          });
                          if (ok) setMissing(null);
                        }}
                      >
                        {t("sit.saveMissed")}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="min-h-11 shrink-0"
                        onClick={() => setMissing(null)}
                      >
                        {t("sit.cancel")}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      <div className="border-t pt-2">
        {care.entries.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("sit.logEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {care.entries.map((e) => {
              const what = entryText(t, e);
              return (
                <li key={e.id} className="flex min-h-11 min-w-0 items-center gap-2 text-sm">
                  <span className="w-16 shrink-0 tabular-nums text-muted-foreground">
                    {orgLocalTime(e.at, tz, locale)}
                  </span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className="font-medium">
                      <bdi>{nameOf(e.pet_id)}</bdi>
                    </span>
                    {": "}
                    <span
                      className={e.status === "missed" ? "text-amber-800 dark:text-amber-300" : ""}
                    >
                      <bdi>{what}</bdi>
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {care.sessionIds.has(e.id) || !e.given_by_name ? (
                        t("sit.byYou")
                      ) : (
                        <bdi>{e.given_by_name}</bdi>
                      )}
                      {e.queued ? ` · ${t("sit.queued")}` : ""}
                    </span>
                  </span>
                  {care.sessionIds.has(e.id) && !disabled && (
                    <Button
                      type="button"
                      variant="ghost"
                      className="min-h-11 shrink-0 px-2"
                      aria-label={t("sit.undoEntry", { what })}
                      onClick={() => undo(e)}
                    >
                      <Undo2 className="me-1 h-4 w-4 shrink-0" aria-hidden="true" />
                      {t("sit.undo")}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {due.length > 0 && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-2.5 text-sm text-amber-900 dark:text-amber-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <div className="min-w-0">
            <div className="font-semibold">{t("sit.beforeYouFinish")}</div>
            <ul className="mt-0.5">
              {due.map((d) => (
                <li key={`${d.petId}-${d.medName}`} className="[overflow-wrap:anywhere]">
                  {t("sit.medNotLogged", {
                    pet: `⁨${d.petName || t("sit.petFallback")}⁩`,
                    med: `⁨${d.medName}⁩`,
                  })}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </fieldset>
  );
}

/** The note for the client, written into the visit report. Uses the walk
 *  report's note (record_walk_report), with pee and poo left unset. */
export function SitNoteField({ visitId, report }: { visitId: string; report: WalkReportState }) {
  const { t } = useTranslation();
  const noteId = `sit-note-${visitId}`;
  return (
    <div>
      <Label htmlFor={noteId} className="text-xs">
        {t("sit.noteForClient")}
      </Label>
      <Textarea
        id={noteId}
        dir="auto"
        rows={2}
        maxLength={REPORT_NOTE_MAX}
        placeholder={t("sit.noteForClientPlaceholder")}
        value={report.note}
        onChange={(e) => report.setNote(e.target.value)}
      />
    </div>
  );
}
