// The top of a groom's card, one block per pet: how to handle it, whether its
// vaccines are good on this groom's date, what was done at its last few
// grooms, and (while the groom is under way) this groom's blade, style and
// problems for the next groomer to read.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { formatDay } from "@/lib/format";
import type { GroomPetFacts } from "@/lib/groom-pets";
import { savePetGroomNote } from "@/lib/pet-groom-notes.functions";

export type GroomPetDog = {
  id?: string | null;
  name?: string | null;
  muzzle_required?: boolean | null;
  bite_history?: boolean | null;
  senior_or_medical?: boolean | null;
  handling_notes?: string | null;
};

const VACCINE_TONE: Record<string, string> = {
  ok: "text-emerald-700 dark:text-emerald-400",
  expiring: "text-amber-700 dark:text-amber-400",
  unverified: "text-amber-700 dark:text-amber-400",
  expired: "text-destructive",
  missing: "text-destructive",
};

function Flag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-semibold text-destructive">
      {children}
    </span>
  );
}

export function GroomPetPanel({
  visitId,
  dogs,
  facts,
  bookedDogIds,
  locale,
  canWrite,
}: {
  visitId: string;
  dogs: unknown;
  facts: GroomPetFacts[] | null | undefined;
  /** The pets booked on this groom. Empty or null (an older plan) shows every pet at the address. */
  bookedDogIds?: readonly string[] | null;
  locale: string | undefined;
  canWrite: boolean;
}) {
  const booked = bookedDogIds && bookedDogIds.length > 0 ? bookedDogIds : null;
  const list = (Array.isArray(dogs) ? (dogs as GroomPetDog[]) : []).filter(
    (d) => d?.id && (!booked || booked.includes(d.id)),
  );
  if (list.length === 0) return null;
  return (
    <div className="mt-2.5 space-y-2">
      {list.map((dog) => (
        <PetBlock
          key={dog.id as string}
          visitId={visitId}
          dog={dog}
          facts={facts?.find((f) => f.dogId === dog.id) ?? null}
          locale={locale}
          canWrite={canWrite}
        />
      ))}
    </div>
  );
}

function PetBlock({
  visitId,
  dog,
  facts,
  locale,
  canWrite,
}: {
  visitId: string;
  dog: GroomPetDog;
  facts: GroomPetFacts | null;
  locale: string | undefined;
  canWrite: boolean;
}) {
  const { t } = useTranslation();
  const name = dog.name?.trim() || t("dog.fallbackName");
  const handling = dog.handling_notes?.trim();
  return (
    <section className="min-w-0 rounded-lg border p-2.5 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">
          <bdi>{name}</bdi>
        </span>
        {dog.muzzle_required && <Flag>{t("groom.muzzle")}</Flag>}
        {dog.bite_history && <Flag>{t("groom.bite")}</Flag>}
        {dog.senior_or_medical && <Flag>{t("groom.senior")}</Flag>}
        {facts?.vaccine && (
          <span className={`text-xs font-medium ${VACCINE_TONE[facts.vaccine] ?? ""}`}>
            {t(`groom.vaccines.${facts.vaccine}`)}
          </span>
        )}
      </div>
      {handling && (
        <p className="mt-1 min-w-0 [overflow-wrap:anywhere]">
          <span className="font-medium">{t("groom.handling")}</span> <bdi>{handling}</bdi>
        </p>
      )}
      {facts && facts.history.length > 0 && (
        <div className="mt-2">
          <p className="text-xs font-medium text-muted-foreground">{t("groom.history")}</p>
          <ul className="mt-1 space-y-1">
            {facts.history.map((h) => (
              <li key={h.groomed_on} className="min-w-0 [overflow-wrap:anywhere]">
                <span className="text-xs text-muted-foreground">
                  {formatDay(h.groomed_on, locale)}
                </span>
                <NoteLine blade={h.blade} style={h.style} problems={h.problems} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {canWrite && dog.id && (
        <NoteForm visitId={visitId} dogId={dog.id} name={name} initial={facts?.current ?? null} />
      )}
    </section>
  );
}

function NoteLine({
  blade,
  style,
  problems,
}: {
  blade: string | null;
  style: string | null;
  problems: string | null;
}) {
  const { t } = useTranslation();
  const parts = [
    ["groom.blade", blade],
    ["groom.style", style],
    ["groom.problems", problems],
  ].filter(([, v]) => v && v.trim()) as [string, string][];
  return (
    <span className="block">
      {parts.map(([key, value], i) => (
        <span key={key}>
          {i > 0 ? " · " : ""}
          <span className="text-muted-foreground">{t(key)}</span> <bdi>{value}</bdi>
        </span>
      ))}
    </span>
  );
}

function NoteForm({
  visitId,
  dogId,
  name,
  initial,
}: {
  visitId: string;
  dogId: string;
  name: string;
  initial: { blade: string | null; style: string | null; problems: string | null } | null;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const saveFn = useServerFn(savePetGroomNote);
  const [blade, setBlade] = useState(initial?.blade ?? "");
  const [style, setStyle] = useState(initial?.style ?? "");
  const [problems, setProblems] = useState(initial?.problems ?? "");
  const save = useMutation({
    mutationFn: () => saveFn({ data: { visitId, dogId, blade, style, problems } }),
    onSuccess: () => {
      toast.success(t("groom.notesSaved"));
      qc.invalidateQueries({ queryKey: ["my-day"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const id = `${visitId}-${dogId}`;
  const empty = !blade.trim() && !style.trim() && !problems.trim();
  return (
    <fieldset className="mt-2 space-y-2 border-t pt-2">
      <legend className="sr-only">{t("groom.notesFor", { name })}</legend>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`blade-${id}`} className="text-xs">
            {t("groom.blade")}
          </Label>
          <Input
            id={`blade-${id}`}
            dir="auto"
            maxLength={120}
            className="h-11"
            value={blade}
            onChange={(e) => setBlade(e.target.value)}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label htmlFor={`style-${id}`} className="text-xs">
            {t("groom.style")}
          </Label>
          <Input
            id={`style-${id}`}
            dir="auto"
            maxLength={240}
            className="h-11"
            value={style}
            onChange={(e) => setStyle(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1">
        <Label htmlFor={`problems-${id}`} className="text-xs">
          {t("groom.problems")}
        </Label>
        <Textarea
          id={`problems-${id}`}
          dir="auto"
          rows={2}
          maxLength={1000}
          value={problems}
          onChange={(e) => setProblems(e.target.value)}
        />
      </div>
      <Button
        type="button"
        variant="outline"
        className="min-h-11"
        disabled={empty || save.isPending}
        onClick={() => save.mutate()}
      >
        {save.isPending ? t("common.saving") : t("groom.saveNotes")}
      </Button>
    </fieldset>
  );
}
